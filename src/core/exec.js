
import {
	noopFn, noopAsyncFn, deferFn,
	animFrameHelper, regexMatchAll, regexExec, regexTest,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	isElementLoaded, setAttribute, eventRegistry,
} from "./utils.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal, signalSymb,
} from "./signal.js";
import {
	scopeExpressionContext, scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "./scope.js";

/**
 * @template {object} execExpOptions
 */
const execExpOptionsDefaults = {
	useReturn: false,
	fnThis: null,
	strictMode: true,
	useAsync: false,
	silentHas: true,
	globalsHide: true,
	throwGlobals: true,
	run: true,
	scopeUseOwn: null,
	scopeCtrl: null,
	useSignalProxy: true
};

/**
 * @typedef {object} execExpInstance
 * @prop {null|any} result
 * @prop {object} firstScope
 * @prop {Function} function
 * @prop {Function} runFn
 * @prop {Error|any} logFnError
 * @prop {Set<object>} getScopes
 * @prop {Set<object>} setScopes
 * @prop {execExpressionProxy|any} proxy
 * @prop {execExpOptions} options
 */

export class execExpression {
	
	static #generateCode(expression,options,fnNameSuffix){
		let { useAsync, strictMode, useReturn } = options;
		let fnName = '$sdcExp'+(fnNameSuffix?.length>0 ? "_"+fnNameSuffix.replace(/[^A-Za-z0-9]/g,'_') : '');
		let fnCode =    "with($sdcScope){let $sdcScope,arguments,constructor;";
		fnCode +=         "return"+(useAsync?"(async ":"(")+"function "+fnName+"(){"+(strictMode?"\"use strict\";":"")+(useAsync?"let $sdcCatchError;":"");
		fnCode += useReturn ? "return (\n\n"+expression+"\n\n);" : "\n\n"+expression+"\n\n";
		fnCode +=         "}).apply(this)"+(useAsync?".catch($sdcCatchError);":";");
		fnCode +=       "}";
		return fnCode;
	}
	
	static #parseScopes(mainScopes,extraScopes){
		if(!(mainScopes instanceof Set)) mainScopes = new Set(mainScopes);
		if(!(extraScopes instanceof Set)) extraScopes = new Set(extraScopes);
		let setScopes = new Set();
		for(let ms of mainScopes) for(let s=ms; s && scopeAllowed(s); s=getPrototypeOf(s)) setScopes.add(s);
		return { getScopes:extraScopes, setScopes };
	}
	
	/**
	 * @param {string} expression
	 * @param {Array<object>|Set<object>} mainScopes
	 * @param {Array<object>|Set<object>} extraScopes
	 * @param {execExpOptions} options
	 * @returns {execExpInstance}
	 */
	static buildExp(expression,mainScopes,extraScopes=[],options={}){
		if(expression!==String(expression)) throw new Error("Invalid expression: "+expression);
		options = { __proto__:null, ...execExpOptionsDefaults, ...options };
		let { fnThis, useAsync, scopeUseOwn, silentHas, globalsHide, throwGlobals, scopeCtrl, useSignalProxy } = options;
		useAsync = options.useAsync = useAsync || expression.indexOf('await')!==-1;
		let globalObj = window, globalCatch = noopFn;
		if(globalsHide && throwGlobals) globalCatch = (key)=>{ throw new Error("Expression tried to access a global variable: "+key); };
		let { getScopes, setScopes } = execExpression.#parseScopes(mainScopes,extraScopes);
		let proxy = new execExpressionProxy({ mainScopes, getScopes, setScopes, scopeUseOwn, silentHas, globalObj, globalsHide, globalCatch, scopeCtrl, useSignalProxy });
		let fnCode = execExpression.#generateCode(expression,options,proxy.$attribute);
		let fn, fnc = useAsync ? functionAsyncProto.constructor : functionProto.constructor;
		let logFnError = (err)=>console.warn(`scopeDom: Error on Expression: ${expression}\n`,err.message,'\n',{ expression, fnCode, function:fn, mainScopes, getScopes, setScopes, result:err });
		try{ fn = (new fnc(useAsync?['$sdcScope','$sdcCatchError']:['$sdcScope'],fnCode)).bind(fnThis||proxy,proxy,logFnError); }
		catch(err){ logFnError(err); }
		let runFn = !fn ? noopFn : function $sdcExpRun(){ try{ return fn(); }catch(err){ return logFnError(err),err; } };
		return { __proto__:null, result:null, firstScope:getScopes.values().next().value, function:fn, runFn, logFnError, getScopes, setScopes, proxy, options };
	}
	
	/**
	 * @param {string} expression
	 * @param {Array<object>|Set<object>} mainScopes
	 * @param {Array<object>|Set<object>} extraScopes
	 * @param {execExpOptions|object|null} fnOptions
	 * @returns {execExpInstance}
	 */
	static runExp(expression,mainScopes,extraScopes=[],fnOptions={}){
		let exec = execExpression.buildExp(expression,mainScopes,extraScopes,fnOptions);
		let { runFn, logFnError, options:{ useAsync, run } } = exec;
		if(run===false) return exec;
		exec.result = runFn();
		if(exec.result instanceof Promise) exec.result.catch(useAsync?noopFn:logFnError);
		return exec;
	}
	
}

const frozenNullObj=Object.freeze(Object.create(null));
export class execExpressionProxy {
	
	constructor(obj){
		obj = { __proto__:null, mainScopes:null, getScopes:null, setScopes:null, scopeUseOwn:null, silentHas:true, globalObj:null, globalsHide:null, globalCatch:null, scopeCtrl:null, useSignalProxy:false, unscopables:frozenNullObj, ...obj };
		if(!obj.scopeUseOwn) obj.scopeUseOwn = new WeakSet();
		return new Proxy(obj,execExpressionProxy);
	}
	
	static has = function execExpHas(obj,prop){
		if(obj.silentHas) return true;
		for(let ms of obj.mainScopes) if(hasOwn(ms,prop)) return Reflect.has(ms,prop);
		for(let s of obj.getScopes){
			if(obj.scopeUseOwn.has(s)){ if(hasOwn(s,prop)) return Reflect.has(s,prop); }
			else if(prop in s) return Reflect.has(s,prop);
		}
		for(let ms of obj.mainScopes) if(prop in ms) return Reflect.has(ms,prop);
		if(obj.globalObj && hasOwn(obj.globalObj,prop)){
			if(obj.globalsHide) return obj.globalCatch(prop), false;
			else return Reflect.has(obj.globalObj,prop);
		}
		return false;
	}
	
	static get = function execExpGet(obj,prop,receiver){
		if(prop===Symbol.unscopables) return obj.unscopables;
		for(let ms of obj.mainScopes) if(hasOwn(ms,prop)) return execExpressionProxy._getResolve(obj,ms,prop,ms);
		for(let s of obj.getScopes){
			if(obj.scopeUseOwn.has(s)){ if(hasOwn(s,prop)) return execExpressionProxy._getResolve(obj,s,prop,s); }
			else if(prop in s) return execExpressionProxy._getResolve(obj,s,prop,s);
		}
		for(let ms of obj.mainScopes) if(prop in ms) return execExpressionProxy._getResolve(obj,ms,prop,ms);
		if(obj.globalObj && hasOwn(obj.globalObj,prop)){
			if(obj.globalsHide) return obj.globalCatch(prop), false;
			else return execExpressionProxy._getResolve(obj,obj.globalObj,prop,obj.globalObj);
		}
		return void 0;
	}
	
	static set = function execExpSet(obj,prop,value,receiver){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return execExpressionProxy._setResolve(obj,s,prop,value,s);
		for(let s of obj.mainScopes) return execExpressionProxy._setResolve(obj,s,prop,value,s);
		return false;
	}
	
	static getOwnPropertyDescriptor(obj,prop){
		for(let s of obj.mainScopes) if(hasOwn(s,prop)) return Reflect.getOwnPropertyDescriptor(s,prop);
		for(let s of obj.getScopes) if(hasOwn(s,prop)) return Reflect.getOwnPropertyDescriptor(s,prop);
		return void 0;
	}
	
	static defineProperty(obj,prop,descriptor){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return Reflect.defineProperty(s,prop,{ __proto__:null, ...descriptor });
		for(let s of obj.mainScopes) return Reflect.defineProperty(s,prop,{ __proto__:null, ...descriptor });
		return false;
	}
	
	static deleteProperty(obj,prop){
		for(let s of obj.setScopes) if(hasOwn(s,prop)){ delete s[prop]; return true; }
		for(let s of obj.mainScopes) if(hasOwn(s,prop)){ delete s[prop]; return true; }
		return false;
	}
	
	static ownKeys(obj){
		return Array.from(new Set(
			[obj.mainScopes,obj.getScopes].map(v=>Array.from(v)).flat(1)
			.reduce((result,item)=>result.concat(Object.keys(item)),[])
		));
	}
	
	static isExtensible(obj){
		return Array.from(obj.setScopes).length>0;
	}
	
	static construct(obj,argumentsList,newTarget){}
	static apply(obj,thisArgument,argumentsList){}
	static setPrototypeOf(obj,prototype){ return false; }
	static getPrototypeOf(obj){ return getPrototypeOf(obj.mainScopes[0]); }
	static preventExtensions(obj){ return false; }
	
	static _getResolve = function execExpGetResolve(obj,target,prop,receiver=target){
		let value = Reflect.get(target,prop,receiver);
		if(obj.useSignalProxy && obj.scopeCtrl?.signalCtrl){
			let isSignal, descriptor = getOwnPropertyDescriptor(target,prop);
			if(descriptor?.value instanceof signalInstance) isSignal = true;
			else if(descriptor?.get?.[signalSymb] instanceof signalInstance) isSignal = true;
			if(descriptor && !isSignal && value===Object(value)) return obj.scopeCtrl.signalCtrl.defineProxySignal(target,prop,value);
		}
		return value;
	}
	
	static _setResolve = function execExpSetResolve(obj,target,prop,value,receiver=target){
		let descriptor = getOwnPropertyDescriptor(target,prop);
		if(descriptor?.value instanceof signalInstance) return descriptor.value.set(value), true;
		return Reflect.set(target,prop,value,receiver);
	}
	
}
