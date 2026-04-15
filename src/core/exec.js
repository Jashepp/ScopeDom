
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
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "./scope.js";

const frozenNullObj=Object.freeze(Object.create(null));

/**
 * execExpression options defaults.
 * @template {object} execExpOptions
 */
const execExpOptionsDefaults = {
	argument: null,
	useReturn: false,
	fnThis: null,
	fnRaw: false,
	strictMode: true,
	useAsync: false,
	silentHas: true,
	globalsHide: true,
	throwGlobals: true,
	run: true,
	scopeUseOwn: null,
	scopeCtrl: null,
	useSignalProxy: false
};

/**
 * execExpression buildExp result.
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

/**
 * Build & Execute Expressions for ScopeDom.
 * @class execExpression
 */
export class execExpression {
	
	/**
	 * Generate wrapper code for an expression.
	 * @param {string} expression The expression to generate code for
	 * @param {execExpOptions} options Execution options
	 * @param {string} fnNameSuffix Suffix for function name
	 * @returns {string} Generated function code
	 */
	static #generateCode(expression,options,fnNameSuffix){
		let { useAsync, strictMode, useReturn } = options;
		let fnName = '$sdcExp'+(fnNameSuffix?.length>0 ? "_"+fnNameSuffix.replace(/[^A-Za-z0-9]/g,'_') : ''), fnCode
		=`with($sdcScope){`
		+	`let $sdcScope,arguments,constructor;`
		+	`return${useAsync ? "(async " : "(" }function ${fnName}(){`
		+		`${strictMode ? "\"use strict\";" : ""}${useAsync ? "let $sdcCatchError;" : ""}`
		+		(useReturn ? `return (\n\n${expression}\n\n);` : `\n\n${expression};\n\n/**/`)
		+	`}).apply(this)${useAsync?".catch($sdcCatchError);":";"}`
		+`}`;
		return fnCode;
	}
	
	/**
	 * Turn scopes to getter & setter lists..
	 * @param {Array<object>|Set<object>} mainScopes Main scopes
	 * @param {Array<object>|Set<object>} extraScopes Extra scopes
	 * @returns {{getScopes:Set<object>, setScopes:Set<object>}} Parsed scopes
	 */
	static #parseScopes(mainScopes,extraScopes){
		if(!(mainScopes instanceof Set)) mainScopes = new Set(mainScopes);
		if(!(extraScopes instanceof Set)) extraScopes = new Set(extraScopes);
		let setScopes = new Set();
		for(let ms of mainScopes) for(let s=ms; s && scopeAllowed(s); s=getPrototypeOf(s)) setScopes.add(s);
		return { getScopes:extraScopes, setScopes };
	}
	
	/**
	 * Expression Function Builder.
	 * @param {string} expression The expression
	 * @param {Array<object>|Set<object>} mainScopes List of main scopes
	 * @param {Array<object>|Set<object>} extraScopes List of extra scopes
	 * @param {execExpOptions} options Expression options
	 * @returns {execExpInstance} Built expression executor result
	 */
	static buildExp(expression,mainScopes,extraScopes=[],options={}){
		if(expression!==String(expression)) throw new Error("Invalid expression: "+expression);
		options = { __proto__:null, ...execExpOptionsDefaults, ...options };
		let { fnThis, useAsync, scopeUseOwn, silentHas, globalsHide, throwGlobals, scopeCtrl, useSignalProxy, argument, fnRaw } = options;
		useAsync = options.useAsync = useAsync || expression.indexOf('await')!==-1;
		let globalObj = window, globalCatch = noopFn, unscopables = execExpProxyDefaults.unscopables, args = ['$sdcScope','$sdcCatchError'];
		if(globalsHide && throwGlobals) globalCatch = (key)=>{ throw new Error("Expression tried to access a global variable: "+key); };
		if(argument?.length>0){ unscopables = { [argument]:true }; args.push(argument); }
		let { getScopes, setScopes } = execExpression.#parseScopes(mainScopes,extraScopes);
		let proxy = new execExpressionProxy({ mainScopes, getScopes, setScopes, scopeUseOwn, silentHas, globalObj, globalsHide, globalCatch, scopeCtrl, useSignalProxy, unscopables });
		let fnCode = execExpression.#generateCode(expression,options,proxy.$attribute);
		let fn, fnc = useAsync ? functionAsyncProto.constructor : functionProto.constructor;
		let logFnError = (err)=>console.warn(`ScopeDom: Error on Expression: ${expression}\n`,err.message,'\n',{ expression, fnCode, function:fn, mainScopes, getScopes, setScopes, result:err });
		try{ fn = (new fnc(args,fnCode)).bind(fnThis||proxy,proxy,logFnError); }
		catch(err){ logFnError(err); }
		let runFn = !fn ? noopFn : (fnRaw ? fn : function $sdcExpRun(a){ try{ return fn(a); }catch(err){ return logFnError(err),err; } });
		return { __proto__:null, result:null, firstScope:getScopes.values().next().value, function:fn, runFn, logFnError, getScopes, setScopes, proxy, options };
	}
	
	/**
	 * Build + Run the Expression Function Builder.
	 * @param {string} expression The expression
	 * @param {Array<object>|Set<object>} mainScopes List of main scopes
	 * @param {Array<object>|Set<object>} extraScopes List of extra scopes
	 * @param {execExpOptions|object|null} options Expression options
	 * @returns {execExpInstance} Built expression executor result
	 */
	static runExp(expression,mainScopes,extraScopes=[],options={}){
		let exec = execExpression.buildExp(expression,mainScopes,extraScopes,options);
		let { runFn, logFnError, options:{ useAsync, run } } = exec;
		if(run===false) return exec;
		exec.result = runFn();
		if(exec.result instanceof Promise) exec.result.catch(useAsync?noopFn:logFnError);
		return exec;
	}
	
}

/**
 * Proxy default options.
 * @template {object} execExpProxyDefaults
 */
const execExpProxyDefaults = {
	mainScopes: null,
	getScopes: null,
	setScopes: null,
	scopeUseOwn: null,
	silentHas: true,
	globalObj: null,
	globalsHide: null,
	globalCatch: null,
	scopeCtrl: null,
	useSignalProxy: true,
	unscopables: frozenNullObj,
};

/**
 * ScopeDom Proxy for expression execution, used in with(proxy).
 * @class execExpressionProxy
 */
export class execExpressionProxy {
	
	/**
	 * Use Proxy options as base Proxy object & state.
	 * @constructor
	 * @param {execExpProxyDefaults|object} obj Proxy options/state
	 */
	constructor(obj){
		obj = { __proto__:null, ...execExpProxyDefaults, ...obj };
		if(!obj.scopeUseOwn) obj.scopeUseOwn = new WeakSet();
		return new Proxy(obj,execExpressionProxy);
	}
	
	/**
	 * Check if a property exists.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name to check
	 * @returns {boolean} True if property exists
	 */
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
	
	/**
	 * Get a property value.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name to get
	 * @param {any} receiver The receiver object
	 * @returns {any} Property value
	 */
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
	
	/**
	 * Set a property value.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name to set
	 * @param {any} value Value to set
	 * @param {any} receiver The receiver object
	 * @returns {boolean} True if property was set
	 */
	static set = function execExpSet(obj,prop,value,receiver){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return execExpressionProxy._setResolve(obj,s,prop,value,s);
		for(let s of obj.mainScopes) return execExpressionProxy._setResolve(obj,s,prop,value,s);
		return false;
	}
	
	/**
	 * Get property descriptor.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name
	 * @returns {PropertyDescriptor|undefined} Property descriptor
	 */
	static getOwnPropertyDescriptor(obj,prop){
		for(let s of obj.mainScopes) if(hasOwn(s,prop)) return Reflect.getOwnPropertyDescriptor(s,prop);
		for(let s of obj.getScopes) if(hasOwn(s,prop)) return Reflect.getOwnPropertyDescriptor(s,prop);
		return void 0;
	}
	
	/**
	 * Define property descriptor.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name
	 * @param {PropertyDescriptor} descriptor Property descriptor
	 * @returns {boolean} True if property was defined
	 */
	static defineProperty(obj,prop,descriptor){
		for(let s of obj.setScopes) if(hasOwn(s,prop)) return Reflect.defineProperty(s,prop,{ __proto__:null, ...descriptor });
		for(let s of obj.mainScopes) return Reflect.defineProperty(s,prop,{ __proto__:null, ...descriptor });
		return false;
	}
	
	/**
	 * Delete property.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {string} prop Property name
	 * @returns {boolean} True if property was deleted
	 */
	static deleteProperty(obj,prop){
		for(let s of obj.setScopes) if(hasOwn(s,prop)){ delete s[prop]; return true; }
		for(let s of obj.mainScopes) if(hasOwn(s,prop)){ delete s[prop]; return true; }
		return false;
	}
	
	/**
	 * Get all own keys.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {string[]} Array of property names
	 */
	static ownKeys(obj){
		return Array.from(new Set(
			[obj.mainScopes,obj.getScopes].map(v=>Array.from(v)).flat(1)
			.reduce((result,item)=>result.concat(Object.keys(item)),[])
		));
	}
	
	/**
	 * Check if extensible.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {boolean} True if extensible
	 */
	static isExtensible(obj){
		return Array.from(obj.setScopes).length>0;
	}
	
	/**
	 * Construct a new instance (not applicable).
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {any[]} argumentsList Arguments list
	 * @param {Function} newTarget New target
	 */
	static construct(obj,argumentsList,newTarget){}
	
	/**
	 * Apply a function (not applicable).
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {any} thisArgument This argument
	 * @param {any[]} argumentsList Arguments list
	 */
	static apply(obj,thisArgument,argumentsList){}
	
	/**
	 * Deny Set prototype.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} prototype Prototype
	 * @returns {boolean} False
	 */
	static setPrototypeOf(obj,prototype){ return false; }
	
	/**
	 * Get prototype of main scope.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {object} Prototype
	 */
	static getPrototypeOf(obj){ return getPrototypeOf(obj.mainScopes[0]); }
	
	/**
	 * Allow extensions.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @returns {boolean} False
	 */
	static preventExtensions(obj){ return false; }
	
	/**
	 * Resolve and get a property value.
	 * Also handle signals.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} target Target object
	 * @param {string} prop Property name
	 * @param {any} receiver Receiver object
	 * @returns {any} Property value
	 */
	static _getResolve = function execExpGetResolve(obj,target,prop,receiver=target){
		let value = Reflect.get(target,prop,target);
		if(obj.useSignalProxy && obj.scopeCtrl?.signalCtrl){
			let signal, descriptor = getOwnPropertyDescriptor(target,prop);
			if(target instanceof signalInstance) target = target.get();
			if(value instanceof signalInstance) signal = value;
			else if(descriptor?.value instanceof signalInstance) signal = descriptor?.value;
			else if(descriptor?.get?.[signalSymb] instanceof signalInstance) signal = descriptor?.get?.[signalSymb];
			// If no signal, and value isn't primitive, define signalProxy
			if(descriptor?.configurable && !signal && value===Object(value)){
				return obj.scopeCtrl.signalCtrl.defineProxySignal(target,prop,value);
			}
			// If value===signal, use signal
			if(descriptor && value===signal){
				return signal;
			}
		}
		return value;
	}
	
	/**
	 * Resolve and set a property value.
	 * Also handle signals.
	 * @param {execExpressionProxy} obj Proxy options/state
	 * @param {object} target Target object
	 * @param {string} prop Property name
	 * @param {any} value Property value
	 * @param {any} receiver Receiver object
	 * @returns {boolean} True on success
	 */
	static _setResolve = function execExpSetResolve(obj,target,prop,value,receiver=target){
		let descriptor = getOwnPropertyDescriptor(target,prop);
		if(descriptor?.set?.[signalSymb] instanceof signalInstance) return descriptor.set(value), true;
		if(descriptor?.value instanceof signalInstance) return descriptor.value.set(value), true;
		return Reflect.set(target,prop,value,target);
	}
	
}
