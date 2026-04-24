
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

const spProxyMap = new WeakMap();
const spTargetMap = new WeakMap();

/**
 * SignalProxy - Creates a deep reactive proxy for objects with automatic signal tracking.
 *
 * A signalProxy creates a proxy that automatically creates signalInstance and
 * signalProxy for every property accessed, enabling infinitely deep reactivity.
 * Each nested property becomes a signal that can be tracked and updated independently.
 * The proxy supports arrays, Maps, Sets, and other iterable collections with special
 * handling for their methods.
 * @class signalProxy
 */
export class signalProxy {
	
	/**
	 * Constructs a new signalProxy.
	 * @param {object} target - Object to proxy
	 * @param {signalController} signalCtrl - The parent signal controller
	 * @param {signalInstance} [targetSignal=null] - Pre-existing signal for the target
	 * @param {boolean} [useWeakRef=false] - Use WeakRef (defaults to true for nested proxies)
	 * @returns {signalProxy} The created proxy, or the target if it's a primitive
	 */
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
	
	/**
	 * Checks if a value is an existing signalProxy.
	 * @param {any} target - Value to check
	 * @returns {boolean} True if the value is an existing signalProxy
	 */
	static _isProxy(target){ return spProxyMap.has(target); }
	
	/**
	 * Gets the signalInstance associated with a signalProxy.
	 * @param {signalProxy} proxy - The signalProxy
	 * @returns {signalInstance} The associated signalInstance, or undefined
	 */
	static _getProxySignal(proxy){ return spProxyMap.get(proxy)?.targetSignal; }
	
	/**
	 * Gets the target for a signalProxy.
	 * @param {signalProxy} proxy - The signalProxy
	 * @returns {any} The target object
	 */
	static _getProxyTarget(proxy){ return spProxyMap.get(proxy)?.target; }
	
	/**
	 * Proxy handler for `has`.
	 *
	 * Checks if a property exists on the target.
	 * Cleans up stale signals and proxies for properties that no longer exist.
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name to check
	 * @returns {boolean} True if the property exists
	 */
	static has = function signalProxyHas(obj,prop){
		let { target, proxies, signals } = obj;
		if(!target) return console.warn("ScopeDom signalProxy: has() called on proxy with gc'd target",{prop}), false;
		let hasProp = target && Reflect.has(target,prop);
		if(!hasProp && signals.get(prop)?.getSilent()!==void 0) signals.delete(prop);
		if(!hasProp && proxies.has(prop)) proxies.delete(prop);
		return hasProp;
	}
	
	/**
	 * Proxy handler for `get`.
	 *
	 * Returns the property value, creating a signal and/or nested proxy as needed.
	 * @see signalProxy._handleTypesGet() - Handles special type-specific behavior for property access
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being accessed
	 * @param {object} receiver - The receiver object (not used)
	 * @returns {any} The property value or nested proxy
	 */
	static get = function signalProxyGet(obj,prop,receiver){
		let getValue, { target, targetSignal, proxies, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: get() called on proxy with gc'd target",{prop});
		if(!signalProxy.has(obj,prop)) return void signalProxy._proxyEnsureSignal(obj,prop,void 0).get();
		try{ getValue = Reflect.get(target,prop,target); }catch(err){ getValue = target[prop]; }
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
	
	/**
	 * Proxy handler for `set`.
	 *
	 * Sets the property value, creating a signal if needed.
	 * Handles special cases for array length and indexed properties.
	 * @see signalProxy._handleTypesSet() - Handles special type-specific behavior for property assignment
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being set
	 * @param {any} value - Value to set
	 * @param {object} receiver - The receiver object (not used)
	 * @returns {boolean} True if the property was set successfully
	 */
	static set = function signalProxySet(obj,prop,value,receiver){
		let getValue, { target, targetSignal, proxies } = obj;
		if(!target) return console.warn("ScopeDom signalProxy: set() called on proxy with gc'd target",{prop}), false;
		try{ getValue = Reflect.get(target,prop,target); }catch(err){ getValue = target[prop]; }
		value = resolveSignal(value);
		value = signalProxy._handleTypesSet(obj,prop,getValue,value);
		if(Reflect.set(target,prop,value,target)){
			let signal = signalProxy._proxyEnsureSignal(obj,prop,getValue,value);
			signal.set(value);
			if(proxies.has(prop) && value!==getValue) proxies.delete(prop);
			return true;
		}
		return false;
	}
	
	/**
	 * Handles special type-specific behavior for property access.
	 *
	 * For iterables (Arrays, Maps, Sets), records dependencies for index access, length/size properties, and method calls.
	 * For functions, returns a wrapper that handles signal tracking.
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being accessed
	 * @param {any} getValue - The property value
	 * @returns {[any, boolean]} Tuple of [value to return, return immediately]
	 */
	static _handleTypesGet(obj,prop,getValue){
		let { target, targetSignal, signalCtrl, isIterable } = obj;
		if(isIterable && targetSignal){
			if(prop===Symbol.iterator) targetSignal.record(); // TODO - wrapper
			else if(prop>=0) targetSignal.record(); // Index props are strings
			else if(target instanceof Array && prop==='length') targetSignal.record();
			else if(target instanceof Map && prop==='size') targetSignal.record();
			else if(target instanceof Set && prop==='size') targetSignal.record();
		}
		if(typeof getValue==='function' && targetSignal){
			let wrapRecordFn, wrapChangeFn;
			if(target instanceof Object && prop==='valueOf') wrapRecordFn = true;
			else if(isIterable){
				if(target instanceof Array && hasOwn(Array.prototype,prop)){
					if(['pop','push','reverse','shift','unshift','splice','sort','copyWithin','fill'].indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof Map && hasOwn(Map.prototype,prop)){
					if(['clear','delete','set','getOrInsert','getOrInsertComputed'].indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof Set && hasOwn(Set.prototype,prop)){
					if(['add','clear','delete'].indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof WeakMap && hasOwn(WeakMap.prototype,prop)){
					if(['delete','set','getOrInsert','getOrInsertComputed'].indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof WeakSet && hasOwn(WeakSet.prototype,prop)){
					if(['add','delete'].indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
			}
			if(wrapChangeFn) return [ function signalProxyFnWrapperChange(...args){
				let result = signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
				return targetSignal.changed(), result;
			}, true ];
			else if(wrapRecordFn) return [ function signalProxyFnWrapperRecord(...args){
				return signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
			}, true ];
		}
		return [ getValue, false ];
	}
	
	/**
	 * Handles special type-specific behavior for property assignment.
	 *
	 * Marks the target signal as changed for array length and indexed property assignments.
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being set
	 * @param {any} getValue - Current property value
	 * @param {any} value - New value being set
	 * @returns {any} The value to set
	 */
	static _handleTypesSet(obj,prop,getValue,value){
		let { target, targetSignal, isIterable } = obj;
		if(isIterable && targetSignal && target instanceof Array && prop==='length') targetSignal.changed();
		else if(isIterable && targetSignal && prop>=0) targetSignal.changed(); // Index props are strings
		return value;
	}
	
	/**
	 * Ensures a signal exists for a property, creates one if needed.
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name
	 * @param {any} [currentValue=void 0] - Current property value
	 * @param {any} [newValue=currentValue] - New property value
	 * @returns {signalInstance} The signal for the property
	 */
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
	
	/**
	 * Proxy handler for property deletion.
	 *
	 * Deletes the property from the target and cleans up associated signals and proxies.
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name to delete
	 * @returns {boolean} True if the property was deleted
	 */
	static deleteProperty(obj,prop){
		let { target, proxies, signals } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: deleteProperty() called on proxy with gc'd target",{prop});
		return proxies.delete(prop), signals.delete(prop), Reflect.deleteProperty(target,prop);
	}
	
	/**
	 * Proxy handler for the 'new' operator.
	 *
	 * Creates a new instance using the target constructor and returns a proxy for the result.
	 * @param {object} obj - The proxy object
	 * @param {any[]} argumentsList - Arguments to pass to the constructor
	 * @param {Function} newTarget - The new target constructor
	 * @returns {signalProxy} A proxy for the created instance
	 */
	static construct(obj,argumentsList,newTarget){
		let { target, targetSignal, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: construct() called on proxy with gc'd target",{argumentsList});
		if(targetSignal) targetSignal.record();
		return new signalProxy(Reflect.construct(target,argumentsList,newTarget),signalCtrl);
	}
	
	/**
	 * Proxy handler for function calls.
	 *
	 * Applies the target function with the given arguments and returns a proxy for the result if it's an object.
	 * @param {object} obj - The proxy object
	 * @param {any} thisArgument - The this value for the function call
	 * @param {any[]} argumentsList - Arguments to pass to the function
	 * @returns {any} The function result or a proxy for it
	 */
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
	
	/**
	 * Proxy handler for Object.defineProperty.
	 * 
	 * TODO: getter & setter may bypass signalProxy
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name
	 * @param {PropertyDescriptor} attributes - Property descriptor
	 * @returns {boolean} True if the property was defined
	 */
	static defineProperty(obj,prop,attributes){ return Reflect.defineProperty(obj.target,prop,attributes); }
	
	/**
	 * Proxy handler for Reflect.getOwnPropertyDescriptor.
	 * 
	 * TODO: getter may bypass signalProxy
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name
	 * @returns {PropertyDescriptor} The property descriptor
	 */
	static getOwnPropertyDescriptor(obj,prop){ Reflect.getOwnPropertyDescriptor(obj.target,prop); }
	
	/**
	 * Proxy handler for Object.setPrototypeOf.
	 * @param {object} obj - The proxy object
	 * @param {object} prototype - The new prototype
	 * @returns {boolean} True if the prototype was set
	 */
	static setPrototypeOf(obj,prototype){ return Reflect.setPrototypeOf(obj.target,prototype); }
	
	/**
	 * Proxy handler for Object.getPrototypeOf.
	 * @param {object} obj - The proxy object
	 * @returns {object} The prototype of the target
	 */
	static getPrototypeOf(obj){ return getPrototypeOf(obj.target); }
	
	/**
	 * Proxy handler for Object.isExtensible.
	 * @param {object} obj - The proxy object
	 * @returns {boolean} True if the target is extensible
	 */
	static isExtensible(obj){ return Reflect.isExtensible(obj.target); }
	
	/**
	 * Proxy handler for Reflect.ownKeys.
	 * @param {object} obj - The proxy object
	 * @returns {string[]} Array of the target's own property keys
	 */
	static ownKeys(obj){ return Reflect.ownKeys(obj.target); }
	
	/**
	 * Proxy handler for Object.preventExtensions.
	 * @param {object} obj - The proxy object
	 * @returns {boolean} True if the target was made non-extensible
	 */
	static preventExtensions(obj){ return Reflect.preventExtensions(obj.target); }
}

/**
 * Resolves a signalProxy or signalInstance to its signalInstance or signal value.
 *
 * This function handles three cases:
 * 1. If the value is a signalProxy, continue with value as a signalInstance.
 * 2. If the value is a signalInstance, optionally record it and return it.
 * 3. If strict=false, the returned value is the signal value.
 * @param {signalProxy|signalInstance|any} value - Value to resolve
 * @param {signalObserver} [signalObs=null] - Optional signalObserver to record the signal
 * @param {boolean} [strict=false] - If true, only return signalInstance or null
 * @returns {signalInstance|any} Resolved signalInstance, its value, or the original value
 */
export const resolveSignal = function(value,signalObs=null,strict=false){
	if(signalProxy._isProxy(value)) value = signalProxy._getProxySignal(value);
	if(value instanceof signalInstance){
		if(signalObs) signalObs.recordSignal(value);
		if(!strict){
			value = value.get();
			if(signalProxy._isProxy(value)) value = signalProxy._getProxyTarget(value);
		}
	}
	if(strict && !(value instanceof signalInstance)) return null;
	return value;
};
