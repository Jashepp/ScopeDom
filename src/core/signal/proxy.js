
import {
	noopFn, noopAsyncFn, setUnion, disposeSymbol, isPromise,
	microtaskCache, mtCacheGetDefinedProperty, mtCacheDefineProperty, mtCacheGetPrototypeOf, mtCacheSetPrototypeOf,
	regexMatchAll, regexExec, regexTest, regexMatchAllFirstGroup,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	setAttribute, eventRegistry,
} from "../utils.js";
import {
	timing,
} from "../timing.js";
import {
	execExpression, execExpressionProxy,
} from "../exec.js";
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "../scope.js";

import { signalController } from "./controller.js";
import { signalObserver } from "./observer.js";
import { signalInstance, signalSymb } from "./instance.js";

/**
 * Forward identity lookup: proxy → its metadata object (target, targetSignal, proxies, signals, signalCtrl).
 *
 * Use the public accessors (_isProxy, _getProxySignal, _getProxyTarget, etc) rather than reading
 * this map directly. WeakMap so GC can clean up orphaned proxies.
 * @type {WeakMap<object, {target, targetSignal, proxies, signals, signalCtrl, isIterable, [fn]?} >}
 */
export const spProxyMap = new WeakMap();

/**
 * Reverse identity lookup: target object → its signalProxy (if one has been created).
 *
 * Used at construction time to deduplicate: if the same target object is proxy-wrapped twice,
 * the second call returns the existing proxy instead of creating a separate one (identity preservation).
 * WeakMap so GC can clean up when the target is no longer referenced.
 * @type {WeakMap<object, object>}
 */
export const spTargetMap = new WeakMap();

/**
 * signalProxy - deep reactive proxy for scope data (auto-infinite nesting, collection method wrapping).
 * 
 * Wraps a plain non-primitive value in a Proxy whose traps intercept property reads, writes,
 * deletions, and (for function targets) calls and constructions. On every property access it
 * ensures a signalInstance exists for that property, so all reads are dependency-tracked and
 * all writes are change-notified without any manual declaration by the caller.
 * This makes DOM reactivity automatic for any wrapped data structure.
 * 
 * Key Behaviours:
 * - Auto-signal-creation: Missing property reads create a signalInstance with undefined value
 *   and return undefined (no TypeError, no property written into the object).
 * - Infinite nesting: Non-primitive values return cached nested signalProxy instances,
 *   creating new ones as needed (useWeakRef:true to allow GC if orphaned).
 * - Two-level collection notification: Array index/length writes and Map/Set method mutations
 *   call targetSignal.changed() directly (structural notification, bypasses === dedup) while
 *   also updating per-property signals via #proxyEnsureSignal().
 * - Method wrapping: Collection mutator methods (push, pop, add, etc) are wrapped to fire
 *   changed() after calling; reader methods (map, filter, get, etc) are wrapped to record()
 *   dependencies without firing changed().
 * - Deduplication: spProxyMap and spTargetMap ensure the same target object is never wrapped
 *   in multiple proxies, preserving identity across expressions.
 * 
 * Interaction with execExpressionProxy:
 *   When signalProxyAll:true (default), expressions running through execExpressionProxy
 *   will automatically create signal proxies via signalCtrl.defineProxySignal() when reading
 *   or writing non-primitive values and new properties.
 *   See execExpressionProxy.#getResolve() and #setResolve().
 * 
 * @see {@link signalController} Central orchestrator for signals, observers, and grouped behaviour.
 * @see {@link signalObserver}   Dependency tracker; records which signals an expression reads.
 * @see {@link signalInstance}   Atomic reactive value (get, set, subscribe, Promise handling, PULL).
 * @see {@link execExpressionProxy} The expression proxy that auto-creates these signal proxies during execution.
 * 
 * @class signalProxy
 */
export class signalProxy {
	
	/**
	 * Creates (or returns) the Proxy for a non-primitive target.
	 * 
	 * If the target already has a proxy (via spProxyMap or spTargetMap identity maps),
	 * returns that existing proxy instead of creating a duplicate - this guarantees identity
	 * is preserved across expressions so observers can compare with strict equality.
	 * 
	 * Constraints:
	 * - Primitives are returned as-is (no signal proxying; use signalInstance for primitives).
	 * - target must be an object (non-primitive).
	 * - If useWeakRef=true, the internal reference to target becomes a WeakRef so garbage
	 *   collection can reclaim orphaned proxy targets. Always true for nested proxies.
	 * 
	 * When proxying a function target, the Proxy creates a synthetic callable so the
	 * returned object is both a signal proxy AND callable via apply.
	 * 
	 * @param {object} target Object to proxy (must be an object, not a primitive)
	 * @param {signalController} signalCtrl The parent signal controller managing this proxy
	 * @param {signalInstance} [targetSignal=null] Pre-existing signal for the target; if none provided, a new one is created
	 * @param {boolean} [useWeakRef=false] Use WeakRef for memory-safe references; enabled explicitly for nested proxies
	 * @returns {signalProxy} The created (or existing) proxy, or the target if it's a primitive
	 */
	constructor(target,signalCtrl,targetSignal=null,useWeakRef=false){
		// Dedup: if target already has a proxy, return existing one to avoid multiple proxies for same object
		if(spProxyMap.has(target)) return target;
		if(spTargetMap.has(target)){ let p=spTargetMap.get(target); if(p!==void 0 && spProxyMap.has(p)) return p; }
		// Primitives are returned as-is (no proxy wrapping needed)
		if(target!==Object(target)) return target;
		// If no pre-existing signal, create one and start recording (so deps are tracked immediately)
		if(!targetSignal){ targetSignal = new signalInstance(signalCtrl,target); targetSignal.record(); }
		let obj = { __proto__:null, target, targetSignal, proxies:new Map(), signals:new Map(), signalCtrl, isIterable:Symbol.iterator in Object(target) };
		// Function targets get their own signalProxyFn wrapper so they behave as both proxy and function
		if(typeof target==='function') obj = Object.assign(function signalProxyFn(){},obj);
		// Memory-safe: store target as a WeakRef so GC can collect if proxy is orphaned
		if(useWeakRef && window.WeakRef) defineWeakRef(obj,'target');
		let proxy = new Proxy(obj,signalProxy);
		// Maintain both directions of identity: proxy-metadata and target-proxy (for dedup)
		spProxyMap.set(proxy,obj);
		spTargetMap.set(target,proxy);
		return proxy;
	}
	
	/**
	 * Proxy handler for `has` (Reflect.has, Object.hasOwn, in operator).
	 * 
	 * Checks if a property exists on the target, and cleans up stale signals & proxies.
	 * 
	 * @param {object} obj The proxy object
	 * @param {string} prop Property name to check existence of
	 * @returns {boolean} True if the property exists on the target, false otherwise; false when the target was garbage-collected (only when the proxy was created using WeakRef)
	 */
	static has(obj,prop){
		let { target, proxies, signals } = obj;
		if(!target) return console.warn("ScopeDom signalProxy: has() called on proxy with gc'd target",{prop}), false;
		let hasProp = target && Reflect.has(target,prop);
		if(!hasProp && signals.get(prop)?.getSilent()!==void 0) signals.delete(prop);
		if(!hasProp && proxies.has(prop)) proxies.delete(prop);
		return hasProp;
	}
	
	/**
	 * Proxy get trap: property read handler that ensures signal tracking and nesting.
	 * 
	 * BEHAVIOUR:
	 * 1. Missing properties are treated as undefined values: a signalInstance is created with
	 *    undefined value and returned. No property is actually written into the target object.
	 * 2. Existing properties: a property-level signalInstance is ensured and updated if the value
	 *    has changed.
	 * 3. Non-primitives: nested signalProxy instances are created (or the cached ones reused) so
	 *    reactivity is maintained infinitely deeply.
	 * 4. Iterables: index and length accesses call targetSignal.record() (dependency tracking).
	 *    Collection method reads are wrapped with #getFnWrapperChange or #getFnWrapperRecord.
	 * 
	 * SIDE EFFECTS:
	 * - Reading missing properties creates signals (no observable effect, but useful for
	 *   dependency tracking in expressions).
	 * - Reading non-primitive properties caches them in obj.proxies Map (WeakRef if useWeakRef).
	 * 
	 * @see {@link _handleTypesGet} Type-specific handling for iterables/functions
	 * @see {@link #proxyEnsureSignal} Signal creation/lookup logic
	 * 
	 * @param {object} obj The proxy object/state
	 * @param {string} prop Property name being accessed
	 * @param {object} [receiver] The receiver object (not used)
	 * @returns {any} The property value or nested proxy; undefined when the target was garbage-collected (only when the proxy was created using WeakRef)
	 */
	static get(obj,prop,receiver){
		let getValue, { target, targetSignal, proxies, signalCtrl } = obj;
		if(!target) return void console.warn("ScopeDom signalProxy: get() called on proxy with gc'd target",{prop});
		// Property doesn't exist yet: auto-create signal and return undefined (will be detected by expression proxy)
		if(!signalProxy.has(obj,prop)) return void signalProxy.#proxyEnsureSignal(obj,prop,void 0).get();
		// Retrieve value from target (try Reflect.get first, fallback to direct access)
		try{ getValue = Reflect.get(target,prop,target); }catch(err){ getValue = target[prop]; }
		// Type-aware handling: iterables (record access; wrap mutators/readers)
		let returnNow; [ getValue, returnNow ] = signalProxy._handleTypesGet(obj,prop,getValue);
		if(returnNow) return getValue;
		// Track signal value; update if changed since last access
		let isPrimitive = getValue!==Object(getValue);
		let signal = signalProxy.#proxyEnsureSignal(obj,prop,getValue);
		if(signal.get()!==getValue) signal.set(getValue);
		// Non-primitive -> primitive transition: delete stale nested proxy
		if(isPrimitive && proxies.has(prop)) proxies.delete(prop);
		if(isPrimitive) return getValue;
		// Nested non-primitive: return cached nested proxy or create a new one (infinitely deep)
		let proxy = proxies.get(prop);
		if(proxy!==void 0) return proxy;
		proxy = new signalProxy(getValue,signalCtrl,signal,true);
		return proxies.set(prop,proxy), proxy;
	}
	
	/**
	 * Proxy set trap: property write handler that notifies change and creates nested proxies.
	 * 
	 * BEHAVIOUR:
	 * 1. Resolves the value being written (unwraps signalProxies and signalInstances to
	 *    their underlying values via `resolveSignal()`).
	 * 2. For array index and length writes (isIterable), fires targetSignal.changed() directly
	 *    (two-level notification: individual property signal + structural array signal).
	 * 3. Updates the signal for that property (creates it if it doesn't exist).
	 * 4. If the existing property was a non-primitive and is now a primitive, deletes the
	 *    cached nested proxy from obj.proxies to free memory.
	 * 
	 * SIDE EFFECTS:
	 * - Fires changed() notification (observers notified in the next microtask).
	 * - Nested proxy cleanup: stale proxies are deleted when a non-primitive value is replaced.
	 * - Does NOT record dependencies (only `get` does that).
	 * 
	 * @see {@link #handleTypesSet} Type-specific handling for iterables
	 * 
	 * @param {object} obj The proxy object/state
	 * @param {string} prop Property name being set
	 * @param {any} value Value to assign to the property
	 * @param {object} [receiver] The receiver object (not used)
	 * @returns {boolean} True if the property was set successfully on target, false otherwise; false when the target was garbage-collected (only when the proxy was created using WeakRef)
	 */
	static set(obj,prop,value,receiver){
		let getValue, { target, targetSignal, proxies } = obj;
		if(!target) return console.warn("ScopeDom signalProxy: set() called on proxy with gc'd target",{prop}), false;
		try{ getValue = Reflect.get(target,prop,target); }catch(err){ getValue = target[prop]; }
		// Unwrap signalProxy/signalInstance values to their underlying raw values before assignment
		value = resolveSignal(value);
		// Type-specific handling: for array index/length writes, fire structural change notification
		value = signalProxy.#handleTypesSet(obj,prop,getValue,value);
		if(Reflect.set(target,prop,value,target)){
			let signal = signalProxy.#proxyEnsureSignal(obj,prop,getValue,value);
			signal.set(value);
			if(proxies.has(prop) && value!==getValue) proxies.delete(prop);
			return true;
		}
		return false;
	}
	
	// Collection method names that trigger structural change notification (`signal.changed()`).
	// Methods are checked against the appropriate prototype when accessed through a signalProxy'd collection.
	static #typeArrayMutators = ['pop','push','reverse','shift','unshift','splice','sort','copyWithin','fill'];
	static #typeMapMutators = ['clear','delete','set','getOrInsert','getOrInsertComputed'];
	static #typeSetMutators = ['add','clear','delete'];
	static #typeWeakMapMutators = ['delete','set','getOrInsert','getOrInsertComputed'];
	static #typeWeakSetMutators = ['add','delete'];
	
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
	 * @param {object} obj The proxy object/state
	 * @param {string} prop Property name being accessed
	 * @param {any} getValue The current property value from the target
	 * @returns {[any,boolean]} Tuple [ value (or wrapped function), true/false (return value instantly or not) ]
	 */
	static _handleTypesGet(obj,prop,getValue){
		let { target, targetSignal, signalCtrl, isIterable } = obj;
		if(isIterable && targetSignal){
			if(prop===Symbol.iterator) targetSignal.record();
			else if(typeof prop==="string" && prop>=0) targetSignal.record(); // Index props are strings
			else if(target instanceof Array && prop==='length') targetSignal.record();
			else if(target instanceof Map && prop==='size') targetSignal.record();
			else if(target instanceof Set && prop==='size') targetSignal.record();
		}
		if(typeof getValue==='function' && targetSignal){
			let wrapRecordFn, wrapChangeFn;
			if(target instanceof Object && prop==='valueOf') wrapRecordFn = true;
			else if(isIterable){
				if(target instanceof Array && hasOwn(Array.prototype,prop)){
					if(signalProxy.#typeArrayMutators.indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof Map && hasOwn(Map.prototype,prop)){
					if(signalProxy.#typeMapMutators.indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof Set && hasOwn(Set.prototype,prop)){
					if(signalProxy.#typeSetMutators.indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof WeakMap && hasOwn(WeakMap.prototype,prop)){
					if(signalProxy.#typeWeakMapMutators.indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
				else if(target instanceof WeakSet && hasOwn(WeakSet.prototype,prop)){
					if(signalProxy.#typeWeakSetMutators.indexOf(prop)!==-1) wrapChangeFn = true;
					else wrapRecordFn = true;
				}
			}
			if(wrapChangeFn) return [ signalProxy.#getFnWrapperChange.bind(null,target,getValue,targetSignal,signalCtrl), true ];
			else if(wrapRecordFn) return [ signalProxy.#getFnWrapperRecord.bind(null,target,getValue,targetSignal,signalCtrl), true ];
		}
		// Not a collection method: Let signalProxyGet handle signal recording
		return [ getValue, false ];
	}
	
	/**
	 * Runs a list of arguments through the apply trap, then fires `signal.changed()` (collection mutation).
	 * 
	 * @private
	 * @param {object} target The object the method is applied to
	 * @param {any} getValue The value backing the object (used as `obj.target` by the apply trap)
	 * @param {signalInstance} targetSignal The signalInstance backing the object
	 * @param {signalController} signalCtrl The parent signal controller
	 * @param {...*} args The arguments the method is called with
	 * @returns {any} The return value of the method
	 */
	static #getFnWrapperChange(target,getValue,targetSignal,signalCtrl,...args){
		let result = signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
		return targetSignal.changed(), result;
	}
	
	/**
	 * Runs a list of arguments through the apply trap without firing `signal.changed()` (collection read).
	 * 
	 * @private
	 * @param {object} target The object the method is applied to
	 * @param {any} getValue The value backing the object (used as `obj.target` by the apply trap)
	 * @param {signalInstance} targetSignal The signalInstance backing the object
	 * @param {signalController} signalCtrl The parent signal controller
	 * @param {...*} args The arguments the method is called with
	 * @returns {any} The return value of the method
	 */
	static #getFnWrapperRecord(target,getValue,targetSignal,signalCtrl,...args){
		return signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
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
	 * @private
	 * @param {object} obj The proxy object
	 * @param {string} prop Property name being set
	 * @param {any} getValue Current property value from the target before assignment
	 * @param {any} value New value being assigned to the property
	 * @returns {any} The value to set on the target
	 */
	static #handleTypesSet(obj,prop,getValue,value){
		let { target, targetSignal, isIterable } = obj;
		if(isIterable && targetSignal && target instanceof Array && prop==="length") targetSignal.changed();
		else if(isIterable && targetSignal && typeof prop==="string" && prop>=0) targetSignal.changed(); // Index props are strings
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
	 * @private
	 * @param {object} obj The proxy object
	 * @param {string} prop Property name
	 * @param {any} [currentValue=undefined] Current property value from the target before assignment
	 * @param {any} [newValue=currentValue] New value being assigned (defaults to currentValue)
	 * @returns {signalInstance} The existing or newly created signal instance for this property
	 */
	static #proxyEnsureSignal(obj,prop,currentValue=void 0,newValue=currentValue){
		let { target, signals, signalCtrl } = obj;
		let signal = signals.get(prop);
		if(signal!==void 0) return signal;
		if(currentValue instanceof signalInstance) return currentValue;
		let descriptor = mtCacheGetDefinedProperty(target,prop);
		if(descriptor?.get?.[signalSymb] instanceof signalInstance) return descriptor.get[signalSymb];
		signal = new signalInstance(signalCtrl,newValue,{ useWeakRef:true });
		signal.record(); signals.set(prop,signal);
		return signal;
	}
	
	/**
	 * Proxy handler for `delete` (Reflect.deleteProperty, delete operator).
	 * 
	 * Deletes the property from the target and cleans up associated signal and proxy.
	 * 
	 * @param {object} obj The proxy object/state
	 * @param {string} prop Property name to delete from the target
	 * @returns {boolean|undefined} True if the property was successfully deleted, false otherwise; undefined when the target was garbage-collected (only when the proxy was created using WeakRef)
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
	 * @param {object} obj The proxy object/state
	 * @param {any[]} argumentsList Array of arguments to pass to the constructor
	 * @param {Function} newTarget The constructor function used with the `new` operator
	 * @returns {signalProxy|undefined} A new signal proxy wrapping the created instance for further reactivity; undefined when the target was garbage-collected (only when the proxy was created using WeakRef)
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
	 * @param {object} obj The proxy object/state
	 * @param {any} thisArgument The `this` value for the function call (may be a proxied object)
	 * @param {any[]} argumentsList Array of arguments to pass to the function
	 * @returns {any} Either the raw function result if primitive, or a new signalProxy wrapping it for reactivity; undefined when the target was garbage-collected (only when the proxy was created using WeakRef)
	 */
	static apply(obj,thisArgument,argumentsList){
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
	 * Defines a property on the target object via `mtCacheDefineProperty(obj.target, prop, attributes)`.
	 * This trap is an intentional pass-through to the raw target.
	 * 
	 * TODO: getter & setter may bypass signalProxy.
	 * 
	 * @param {object} obj The proxy object/state
	 * @param {string} prop Property name to define on the target
	 * @param {PropertyDescriptor} attributes The property descriptor defining configurable, enumerable, get, set, value, etc.
	 * @returns {boolean} True if the property was successfully defined on the target, false otherwise
	 */
	static defineProperty(obj,prop,attributes){ return mtCacheDefineProperty(obj.target,prop,attributes); }
	
	/**
	 * Proxy handler for `getOwnPropertyDescriptor` (getOwnPropertyDescriptor trap).
	 * 
	 * Returns the property descriptor from the target object via `mtCacheGetDefinedProperty(obj.target, prop)`.
	 * This trap is an intentional pass-through to the raw target.
	 * 
	 * TODO: getter & setter may bypass signalProxy.
	 * 
	 * @param {object} obj The proxy object/state
	 * @param {string} prop Property name to get descriptor for
	 * @returns {PropertyDescriptor} The property descriptor from the target, or undefined if not found
	 */
	static getOwnPropertyDescriptor(obj,prop){ return mtCacheGetDefinedProperty(obj.target,prop); }
	
	/**
	 * Proxy handler for `setPrototypeOf` (setPrototypeOf trap).
	 * 
	 * Sets the prototype of the target object using Reflect.setPrototypeOf.
	 * 
	 * @param {object} obj The proxy object/state
	 * @param {object} prototype The new prototype to set on the target
	 * @returns {boolean} True if the prototype was successfully set, false otherwise
	 */
	static setPrototypeOf(obj,prototype){ return mtCacheSetPrototypeOf(obj.target,prototype); }
	
	/**
	 * Proxy handler for `getPrototypeOf` (getPrototypeOf trap).
	 * 
	 * Returns the prototype of the target object using Object.getPrototypeOf.
	 * 
	 * @param {object} obj The proxy object/state
	 * @returns {object} The prototype of the target object
	 */
	static getPrototypeOf(obj){ return mtCacheGetPrototypeOf(obj.target); }
	
	/**
	 * Proxy handler for `isExtensible` (isExtensible trap).
	 * 
	 * Returns if the target object allows new properties to be added using Reflect.isExtensible.
	 * 
	 * @param {object} obj The proxy object/state
	 * @returns {boolean} True if the target object is extensible (allows new properties), false otherwise
	 */
	static isExtensible(obj){ return Reflect.isExtensible(obj.target); }
	
	/**
	 * Proxy handler for `ownKeys` (ownKeys trap).
	 * 
	 * Returns all own property keys (including symbols) from the target using Reflect.ownKeys.
	 * 
	 * @param {object} obj The proxy object/state
	 * @returns {Array<string|symbol>} Array of own property keys from the target (property names and symbols)
	 */
	static ownKeys(obj){ return Reflect.ownKeys(obj.target); }
	
	/**
	 * Proxy handler for `preventExtensions` (preventExtensions trap).
	 * 
	 * Delegates to Reflect.preventExtensions on the target object.
	 * 
	 * @param {object} obj The proxy object/state
	 * @returns {boolean} Result of Reflect.preventExtensions on the target (always true in non-strict mode)
	 */
	static preventExtensions(obj){ return Reflect.preventExtensions(obj.target); }
	
	/**
	 * Check if a value is a signalProxy (useful for type checking in plugin code).
	 * 
	 * @param {object} target Value to check
	 * @returns {boolean} True if the value is an existing signalProxy
	 */
	static _isProxy(target){ return spProxyMap.has(target); }
	
	/**
	 * Get the signalInstance behind a signalProxy target (the root signal for the wrapped object).
 	 * 
	 * @param {signalProxy} proxy The signalProxy
	 * @returns {signalInstance} The associated signalInstance, or undefined
	 */
	static _getProxySignal(proxy){ return spProxyMap.get(proxy)?.targetSignal; }
	
	/**
	 * Get the underlying target object that a signalProxy wraps.
	 * 
	 * @param {signalProxy} proxy The signalProxy
	 * @returns {object} The target object
	 */
	static _getProxyTarget(proxy){ return spProxyMap.get(proxy)?.target; }
	
	/**
	 * Check if a target object already has an existing signalProxy wrapper.
	 * 
	 * @param {object} target The target object
	 * @returns {boolean} True if the target has a signalProxy
	 */
	static _hasTargetProxy(target){ return spTargetMap.has(target); }
	
	/**
	 * Get the existing signalProxy wrapper for a target object.
	 * 
	 * @param {object} target The target object
	 * @returns {signalProxy} The signalProxy
	 */
	static _getTargetProxy(target){ return spTargetMap.get(target); }
	
	/**
	 * Resolves a signalProxy or signalInstance to its signalInstance or raw value.
	 * 
	 * Method Flow:
	 * 1. If value is a signalProxy, extract its targetSignal and continue processing with that as `value`
	 * 2. If value is a signalInstance, optionally record it on the observer, then either return it (strict mode) or get() its value
	 * 3. In strict=false mode, after getting the signalInstance's value, if that resolved to another proxy, extract its target
	 * 
	 * Usage:
	 *   - When writing expressions manually, pass strict=true to get back the signalInstance
	 *     for programmatic observation or mutation.
	 *   - When passing values between signal-aware code and plain code, pass signalObs
	 *     to register the signal as a dependency (for expression evaluation).
	 *   - Default behaviour: flatten signalInstance and signalProxy values to their
	 *     underlying raw values.
	 * 
	 * @param {any} value The value to resolve (can be signalProxy, signalInstance, or any other type)
	 * @param {signalObserver} [signalObs=null] Optional observer to record the signal as a dependency during resolution
	 * @param {boolean} [strict=false] If true, only return signalInstance or null
	 * @returns {any} The resolved value, either a signalInstance (strict=true), its underlying value, or the original non-signal value
	 */
	static _resolveSignal(value,signalObs=null,strict=false){
		if(spProxyMap.has(value)) value = spProxyMap.get(value).targetSignal;
		if(value instanceof signalInstance){
			if(signalObs) signalObs.recordSignal(value);
			if(!strict){
				value = value.get();
				if(spProxyMap.has(value)) value = spProxyMap.get(value)?.target;
			}
		}
		if(strict && !(value instanceof signalInstance)) return null;
		return value;
	};
}

/**
 * Convenience export of signalProxy._resolveSignal - flatten a signalProxy or signalInstance to its raw value.
 * Use when you need to extract the underlying value from a wrapped signal-aware object.
 * 
 * @type {typeof signalProxy._resolveSignal}
 */
export const resolveSignal = signalProxy._resolveSignal;
