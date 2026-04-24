
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

/** @type {WeakMap<object>} Maps proxy objects to their metadata. WeakMap[proxy->metadata] */
const spProxyMap = new WeakMap();

/** @type {WeakMap<object>} Reverse mapping from original targets to their proxies. WeakMap[target->proxy] */
const spTargetMap = new WeakMap();

/**
 * Signal Proxy for deep reactivity for objects with automatic signal tracking.
 * 
 * The signal proxy is what enables reactivity within expressions, for the reactive signal system.
 * 
 * A signalProxy creates a proxy that automatically creates signalInstance and
 * signalProxy for every property accessed, enabling infinitely deep reactivity.
 * Each nested property becomes a signal that can be tracked and updated independently.
 * The proxy supports arrays, Maps, Sets, and other iterable collections with special
 * handling for their methods.
 * 
 * @class signalProxy
 * @see {@link signalController} - Signal Controller for managing signals and observers
 * @see {@link signalObserver} - Signal Observer for tracking signal dependencies
 * @see {@link signalInstance} - Signal Instance that represents a reactive signal value
 */
export class signalProxy {
	
	/**
	 * Constructs a new signalProxy.
	 * 
	 * @param {object} target - Object to proxy (must be an object, not a primitive)
	 * @param {signalController} signalCtrl - The parent signal controller managing this proxy
	 * @param {signalInstance} [targetSignal=null] - Pre-existing signal for the target; if none provided, a new one is created
	 * @param {boolean} [useWeakRef=false] - Use WeakRef for memory-safe references (defaults to true for nested proxies)
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
	 * 
	 * @param {object} target - Value to check
	 * @returns {boolean} True if the value is an existing signalProxy
	 */
	static _isProxy(target){ return spProxyMap.has(target); }
	
	/**
	 * Gets the signalInstance associated with a signalProxy.
	 * 
	 * @param {signalProxy} proxy - The signalProxy
	 * @returns {signalInstance} The associated signalInstance, or undefined
	 */
	static _getProxySignal(proxy){ return spProxyMap.get(proxy)?.targetSignal; }
	
	/**
	 * Gets the target for a signalProxy.
	 * 
	 * @param {signalProxy} proxy - The signalProxy
	 * @returns {object} The target object
	 */
	static _getProxyTarget(proxy){ return spProxyMap.get(proxy)?.target; }
	
	/**
	 * Proxy handler for `has` (Reflect.has, Object.hasOwn, in operator).
	 * 
	 * Checks if a property exists on the target, and cleans up stale signals & proxies.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name to check existence of
	 * @returns {boolean} True if the property exists on the target, false otherwise
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
	 * Proxy handler for `get` (property access).
	 * 
	 * Returns the property value, creating a signal and/or nested proxy as needed.
	 * 
	 * Method Flow:
	 * 1. Check if property exists on target (if not, create signal and return)
	 * 2. Retrieve the actual value using Reflect.get with fallback to target[prop]
	 * 3. Delegate to `_handleTypesGet()` for type-specific handling (iterables, functions)
	 * 4. Ensure a signal exists for the property and update it if value changed
	 * 5. For non-primitive values, create or return nested proxy
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being accessed
	 * @param {object} [receiver] The receiver object (not used)
	 * @returns {any} The property value or nested proxy; undefined if target was garbage collected
	 * @see {@link _handleTypesGet} Type-specific handling for iterables/functions
	 * @see {@link _proxyEnsureSignal} Signal creation/lookup logic
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
	 * Proxy handler for `set` (property assignment).
	 * 
	 * Sets the property value on the target, creating a signal if needed.
	 * Handles special cases for array length and indexed properties.
	 * 
	 * Method Flow:
	 * 1. Retrieve current value using Reflect.get with fallback to target[prop]
	 * 2. Resolve any signals/proxies in the new value (eg: if setting a proxy, extract its signal)
	 * 3. Delegate to `_handleTypesSet()` for type-specific handling (iterables)
	 * 4. Set property on target and update signal with new value
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being set
	 * @param {any} value - Value to assign to the property
	 * @param {object} [receiver] The receiver object (not used)
	 * @returns {boolean} True if the property was set successfully on target, false otherwise
	 * @see {@link _handleTypesSet} Type-specific handling for iterables
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
	 * Handles special type-specific behavior for property access (get operations).
	 * 
	 * For iterables (Arrays, Maps, Sets), call signal.record() when accessing:
	 * - Index properties (array[0])
	 * - Iterable properties like Array.length, Map.size, Set.size, Symbol.iterator
	 * 
	 * Or return wrapper functions that call either signal.changed() or signal.record() for:
	 * - Methods that modify data (push, pop, add, delete, etc.)
	 * - Methods that read data
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being accessed
	 * @param {any} getValue - The current property value from the target
	 * @returns {[any,boolean]} Tuple [ value (or wrapped function), true/false (return value instantly or not) ]
	 */
	static _handleTypesGet(obj,prop,getValue){
		let { target, targetSignal, signalCtrl, isIterable } = obj;
		if(isIterable && targetSignal){
			if(prop===Symbol.iterator) targetSignal.record();
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
		// Let signalProxyGet do signal record
		return [ getValue, false ];
	}
	
	/**
	 * Handles special type-specific behavior for property assignment (set operations).
	 * 
	 * For iterables (Arrays), call signal.changed() when accessing:
	 * - Array.length
	 * - Index properties (array[0])
	 * 
	 * This ensures reactive updates propagate to observers when collection indices are modified.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name being set
	 * @param {any} getValue - Current property value from the target before assignment
	 * @param {any} value - New value being assigned to the property
	 * @returns {any} The value to set on the target
	 */
	static _handleTypesSet(obj,prop,getValue,value){
		let { target, targetSignal, isIterable } = obj;
		if(isIterable && targetSignal && target instanceof Array && prop==='length') targetSignal.changed();
		else if(isIterable && targetSignal && prop>=0) targetSignal.changed(); // Index props are strings
		return value;
	}
	
	/**
	 * Ensures a signal exists for a given property on the proxy object, creating one if needed.
	 * 
	 * Method Flow:
	 * 1. If a signal already exists in `signals` map for this property, return it
	 * 2. If the current value is already a signalInstance, return it
	 * 3. If the target[prop] has a getter with an existing signal attached, return it
	 * 4. Otherwise create a new signal, record it, store it, return it
	 * 
	 * This method ensures that the target[prop] has an associated signal for dependency tracking.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name
	 * @param {any} [currentValue=undefined] Current property value from the target before assignment
	 * @param {any} [newValue=currentValue] New value being assigned (defaults to currentValue)
	 * @returns {signalInstance} The existing or newly created signal instance for this property
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
	 * Proxy handler for `delete` (Reflect.deleteProperty, delete operator).
	 * 
	 * Deletes the property from the target and cleans up associated signal and proxy.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name to delete from the target
	 * @returns {boolean} True if the property was successfully deleted, false otherwise
	 */
	static deleteProperty(obj,prop){
		let { target, proxies, signals } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: deleteProperty() called on proxy with gc'd target",{prop});
		return proxies.delete(prop), signals.delete(prop), Reflect.deleteProperty(target,prop);
	}
	
	/**
	 * Proxy handler for `new` (Reflect.construct, new operator).
	 * 
	 * Creates a new instance by calling the target constructor with provided arguments,
	 * then returns a signalProxy wrapping the newly created instance.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {any[]} argumentsList - Array of arguments to pass to the constructor
	 * @param {Function} newTarget - The constructor function used with the `new` operator
	 * @returns {signalProxy} A new signal proxy wrapping the created instance for further reactivity
	 */
	static construct(obj,argumentsList,newTarget){
		let { target, targetSignal, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: construct() called on proxy with gc'd target",{argumentsList});
		if(targetSignal) targetSignal.record();
		return new signalProxy(Reflect.construct(target,argumentsList,newTarget),signalCtrl);
	}
	
	/**
	 * Proxy handler for `apply` (function invocation, Function.apply).
	 * 
	 * Applies the target function with given arguments and returns a signalProxy wrapping the result, or the raw result if primitive.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {any} thisArgument - The `this` value for the function call (may be a proxied object)
	 * @param {any[]} argumentsList - Array of arguments to pass to the function
	 * @returns {any} Either the raw function result if primitive, or a new signalProxy wrapping it for reactivity
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
	 * Proxy handler for `defineProperty` (defineProperty trap).
	 * 
	 * Defines a property on the target object using Reflect.defineProperty.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name to define on the target
	 * @param {PropertyDescriptor} attributes - The property descriptor defining configurable, enumerable, get, set, value, etc.
	 * @returns {boolean} True if the property was successfully defined on the target, false otherwise
	 */
	static defineProperty(obj,prop,attributes){ return Reflect.defineProperty(obj.target,prop,attributes); }
	
	/**
	 * Proxy handler for `getOwnPropertyDescriptor` (getOwnPropertyDescriptor trap).
	 * 
	 * Returns the property descriptor from the target object using Reflect.getOwnPropertyDescriptor.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {string} prop - Property name to get descriptor for
	 * @returns {PropertyDescriptor} The property descriptor from the target, or undefined if not found
	 */
	static getOwnPropertyDescriptor(obj,prop){ Reflect.getOwnPropertyDescriptor(obj.target,prop); }
	
	/**
	 * Proxy handler for `setPrototypeOf` (setPrototypeOf trap).
	 * 
	 * Sets the prototype of the target object using Reflect.setPrototypeOf.
	 * 
	 * @param {object} obj - The proxy object
	 * @param {object} prototype - The new prototype to set on the target
	 * @returns {boolean} True if the prototype was successfully set, false otherwise
	 */
	static setPrototypeOf(obj,prototype){ return Reflect.setPrototypeOf(obj.target,prototype); }
	
	/**
	 * Proxy handler for `getPrototypeOf` (getPrototypeOf trap).
	 * 
	 * Returns the prototype of the target object using Object.getPrototypeOf.
	 * 
	 * @param {object} obj - The proxy object
	 * @returns {object} The prototype of the target object
	 */
	static getPrototypeOf(obj){ return getPrototypeOf(obj.target); }
	
	/**
	 * Proxy handler for `isExtensible` (isExtensible trap).
	 * 
	 * Returns if the target object allows new properties to be added using Reflect.isExtensible.
	 * 
	 * @param {object} obj - The proxy object
	 * @returns {boolean} True if the target object is extensible (allows new properties), false otherwise
	 */
	static isExtensible(obj){ return Reflect.isExtensible(obj.target); }
	
	/**
	 * Proxy handler for `ownKeys` (ownKeys trap).
	 * 
	 * Returns all own property keys (including symbols) from the target using Reflect.ownKeys.
	 * 
	 * @param {object} obj - The proxy object
	 * @returns {string[]} Array of own property keys from the target (property names and symbols)
	 */
	static ownKeys(obj){ return Reflect.ownKeys(obj.target); }
	
	/**
	 * Proxy handler for `preventExtensions` (preventExtensions trap).
	 * 
	 * Prevents new properties from being added to the target using Reflect.preventExtensions.
	 * 
	 * @param {object} obj - The proxy object
	 * @returns {boolean} True if the target was successfully made non-extensible, false otherwise
	 */
	static preventExtensions(obj){ return Reflect.preventExtensions(obj.target); }
}

/**
 * Resolves a signalProxy or signalInstance to its signalInstance or signal value.
 * 
 * Method Flow:
 * 1. If value is a signalProxy, extract its targetSignal and continue processing with that as `value`
 * 2. If value is a signalInstance, optionally record it on the observer, then either return it (strict mode) or get() its value
 * 3. In strict=false mode, after getting the signal instance's value, if that resolved to another proxy, extract its target
 * 
 * @param {any} value - The value to resolve (can be signalProxy, signalInstance, or any other type)
 * @param {signalObserver} [signalObs=null] - Optional observer to record the signal as a dependency during resolution
 * @param {boolean} [strict=false] - If true, only return signalInstance, otherwise returns null
 * @returns {any} The resolved value, either a signalInstance (strict=true), its underlying value, or the original non-signal value
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
