
import {
	noopFn, noopAsyncFn, deferFn,
	animFrameHelper, regexMatchAll, regexExec, regexTest,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	isElementLoaded, setAttribute, eventRegistry,
} from "../utils.js";
import {
	execExpression, execExpressionProxy,
} from "../exec.js";
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "../scope.js";

import { signalController } from "./controller.js";
import { signalObserver } from "./observer.js";
import { signalInstance, signalSymb } from "./instance.js";

const spProxyMap = new WeakMap(), spTargetMap = new WeakMap();

export class signalProxy {
	
	constructor(target,signalCtrl,targetSignal=null,useWeakRef=false){
		if(spProxyMap.has(target)) return target;
		if(spTargetMap.has(target)){ let p=spTargetMap.get(target); if(p && spProxyMap.has(p)) return p; }
		if(target!==Object(target)) return target;
		if(!targetSignal){ targetSignal = new signalInstance(signalCtrl,target); targetSignal.record(); }
		let obj = { __proto__:null, target, targetSignal, proxies:new Map(), signals:new Map(), signalCtrl, isIterable:Symbol.iterator in Object(target) };
		if(typeof target==='function') obj = Object.assign(function signalProxyFn(){},obj);
		if(useWeakRef && window.WeakRef) defineWeakRef(obj,'target');
		let proxy = new Proxy(obj,signalProxy);
		spProxyMap.set(proxy,obj);
		spTargetMap.set(target,proxy);
		return proxy;
	}
	
	static _isProxy(target){ return spProxyMap.has(target); }
	
	static _getProxySignal(target){ return spProxyMap.get(target)?.targetSignal; }
	
	static has = function signalProxyHas(obj,prop){
		let { target, proxies, signals } = obj;
		if(!target) return console.warn("ScopeDom signalProxy: has() called on proxy with gc'd target",{prop}), false;
		let hasProp = target && Reflect.has(target,prop);
		if(!hasProp && signals.get(prop)?.getSilent()!==void 0) signals.delete(prop);
		if(!hasProp && proxies.has(prop)) proxies.delete(prop);
		return hasProp;
	}
	
	static get = function signalProxyGet(obj,prop,receiver){
		let getValue, { target, targetSignal, proxies, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: get() called on proxy with gc'd target",{prop});
		if(!signalProxy.has(obj,prop)) return void signalProxy._proxyEnsureSignal(obj,prop,void 0).get();
		try{ getValue = Reflect.get(target,prop,receiver); }catch(err){ getValue = target[prop]; }
		let returnNow; [ getValue, returnNow ] = signalProxy._handleTypesGet(obj,prop,getValue);
		if(returnNow) return getValue;
		let isPrimitive = getValue!==Object(getValue);
		let signal = signalProxy._proxyEnsureSignal(obj,prop,getValue);
		if(signal.get()!==getValue) signal.set(getValue);
		if(isPrimitive && proxies.has(prop)) proxies.delete(prop);
		if(isPrimitive) return getValue;
		if(proxies.has(prop)) return proxies.get(prop);
		let proxy = new signalProxy(getValue,signalCtrl,signal,true);
		return proxies.set(prop,proxy), proxy;
	}
	
	static set = function signalProxySet(obj,prop,value,receiver){
		let getValue, { target, targetSignal, proxies } = obj;
		if(!target) return console.warn("ScopeDom signalProxy: set() called on proxy with gc'd target",{prop}), false;
		try{ getValue = Reflect.get(target,prop,receiver); }catch(err){ getValue = target[prop]; }
		value = resolveSignal(value);
		value = signalProxy._handleTypesSet(obj,prop,getValue,value);
		if(Reflect.set(target,prop,value,receiver)){
			let signal = signalProxy._proxyEnsureSignal(obj,prop,getValue,value);
			signal.set(value);
			if(proxies.has(prop) && value!==getValue) proxies.delete(prop);
			return true;
		}
		return false;
	}
	
	static _handleTypesGet(obj,prop,getValue){
		let { target, targetSignal, signalCtrl, isIterable } = obj;
		if(isIterable && targetSignal){
			if(prop===Symbol.iterator) targetSignal.record(); // TODO - wrapper
			else if(prop*1>=0) targetSignal.record();
			else if(target instanceof Array && prop==='length') targetSignal.record();
			else if(target instanceof Map && prop==='size') targetSignal.record();
			else if(target instanceof Set && prop==='size') targetSignal.record();
		}
		if(typeof getValue!=='function') return [ getValue, false ];
		let wrapRecordFn, wrapChangeFn;
		if(target instanceof Object && prop==='valueOf') wrapRecordFn = true;
		else if(isIterable && target instanceof Array && hasOwn(Array.prototype,prop)){
			if(['pop','push','reverse','shift','unshift','splice','sort','copyWithin','fill'].indexOf(prop)!==-1) wrapChangeFn = true;
			else wrapRecordFn = true;
		}
		else if(isIterable && target instanceof Map && hasOwn(Map.prototype,prop)){
			if(['clear','delete','set','getOrInsert','getOrInsertComputed'].indexOf(prop)!==-1) wrapChangeFn = true;
			else wrapRecordFn = true;
		}
		else if(isIterable && target instanceof Set && hasOwn(Set.prototype,prop)){
			if(['add','clear','delete'].indexOf(prop)!==-1) wrapChangeFn = true;
			else wrapRecordFn = true;
		}
		else if(isIterable && target instanceof WeakMap && hasOwn(WeakMap.prototype,prop)){
			if(['delete','set','getOrInsert','getOrInsertComputed'].indexOf(prop)!==-1) wrapChangeFn = true;
			else wrapRecordFn = true;
		}
		else if(isIterable && target instanceof WeakSet && hasOwn(WeakSet.prototype,prop)){
			if(['add','delete'].indexOf(prop)!==-1) wrapChangeFn = true;
			else wrapRecordFn = true;
		}
		if(wrapChangeFn) return [ function signalProxyFnWrapperChange(...args){
			let result = signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
			return targetSignal.changed(), result;
		}, true ];
		else if(wrapRecordFn) return [ function signalProxyFnWrapperRecord(...args){
			return signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
		}, true ];
		return [ getValue, false ];
	}
	
	static _handleTypesSet(obj,prop,getValue,value){
		let { target, targetSignal, isIterable } = obj;
		if(isIterable && targetSignal && target instanceof Array && prop==='length') targetSignal.changed();
		else if(isIterable && targetSignal && prop*1>=0) targetSignal.changed();
		return value;
	}
	
	static _proxyEnsureSignal(obj,prop,currentValue=void 0,newValue=currentValue){
		let signal, { target, signals, signalCtrl } = obj;
		if(signals.has(prop)) return signals.get(prop);
		if(currentValue instanceof signalInstance) return currentValue;
		let descriptor = getOwnPropertyDescriptor(target,prop);
		if(descriptor?.get?.[signalSymb] instanceof signalInstance) return descriptor.get[signalSymb];
		signal = new signalInstance(signalCtrl,newValue,true);
		signal.record(); signals.set(prop,signal);
		return signal;
	}
	
	static deleteProperty(obj,prop){
		let { target, proxies, signals } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: deleteProperty() called on proxy with gc'd target",{prop});
		return proxies.delete(prop), signals.delete(prop), Reflect.deleteProperty(target,prop);
	}
	
	static construct(obj,argumentsList,newTarget){
		let { target, targetSignal, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: construct() called on proxy with gc'd target",{argumentsList});
		if(targetSignal) targetSignal.record();
		return new signalProxy(Reflect.construct(target,argumentsList,newTarget),signalCtrl);
	}
	
	static apply = function signalProxyApply(obj,thisArgument,argumentsList){
		let { target, targetSignal, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: apply() called on proxy with gc'd target",{thisArgument,argumentsList});
		let thisTarget = spProxyMap.get(thisArgument)?.target || thisArgument;
		targetSignal.record();
		let result = Reflect.apply(target,thisTarget,argumentsList);
		let isPrimitive = result!==Object(result);
		if(isPrimitive) return result;
		return new signalProxy(result,signalCtrl);
	}
	
	static defineProperty(obj,prop,attributes){ return Reflect.defineProperty(obj.target,prop,attributes); }
	
	static getOwnPropertyDescriptor(obj,prop){ Reflect.getOwnPropertyDescriptor(obj.target,prop); }
	
	static setPrototypeOf(obj,prototype){ return Reflect.setPrototypeOf(obj.target,prototype); }
	
	static getPrototypeOf(obj){ return getPrototypeOf(obj.target); }
	
	static isExtensible(obj){ return Reflect.isExtensible(obj.target); }
	
	static ownKeys(obj){ return Reflect.ownKeys(obj.target); }
	
	static preventExtensions(obj){ return Reflect.preventExtensions(obj.target); }
}

/**
 * Resolve (& record) a signalProxy to it's signalInstance
 * @param {signalProxy|signalInstance|any} value Value
 * @param {signalObserver=} signalObs Signal Observer
 * @param {boolean=} strict Only return signalInstance or null, not the value
 * @returns {signalInstance|null} If strict, resolved signalInstance or null. Else resolved signalInstance value or passed value.
 */
export const resolveSignal = function(value,signalObs=null,strict=false){
	if(signalProxy._isProxy(value)) value = signalProxy._getProxySignal(value);
	if(value instanceof signalInstance){
		if(signalObs) signalObs.recordSignal(value);
		if(!strict) value = value.get();
	}
	if(strict && !(value instanceof signalInstance)) return null;
	return value;
};
