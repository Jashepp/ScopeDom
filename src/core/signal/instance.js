
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
import { signalProxy, resolveSignal } from "./proxy.js";

/** @type {Symbol} Used to store signalInstance on descriptors */
export const signalSymb = Symbol('$signalInstance');

/** @type {WeakMap<object>} WeakMap / Cache of signals to re-use existing instances */
const signalsMap = new WeakMap();

/**
 * Signal Instance that represents a reactive signal value.
 * 
 * The signal instance is the core mechanism of the reactive signal system.
 * 
 * This class implements:
 * - Signal Controller & Signal Observer hooks to handle dependancy tracking
 * - Promise/async value handling with automatic change notification
 * - WeakRef support for object values (memory-safe references)
 * - Pull-based listeners for lazy evaluation patterns
 * - Handy type methods (thenable, Symbol.toPrimitive, etc.)
 * 
 * @class signalInstance
 * @property {signalController} ctrl - The parent signal controller managing this instance
 * @property {any} value - The current signal value (also accessible via get()/set())
 * 
 * @see {@link signalController} - Signal Controller for managing signals and observers
 * @see {@link signalObserver} - Signal Observer for tracking signal dependencies
 * @see {@link signalProxy} - Signal Proxy for deep reactivity for objects with automatic signal tracking
 */
export class signalInstance {
	
	/** @type {signalController} Reference to parent signal controller managing this instance */
	#ctrl = null;
	
	/** @type {any} The raw or WeakRef'd signal value */
	#_value = null;
	
	/** @type {Promise|null} Storage for pending Promise values */
	#_promise = null;
	
	/** @type {boolean} Is WeakRef enabled */
	#useWeakRef = false;
	
	/** @type {boolean} Is value an object (not a primitive) */
	#isObject = false;
	
	/** @type {boolean} Is already in get() operation */
	#isGetting = true;
	
	/** @type {boolean} If signal needs recomputation for PULL-based computed signals */
	#pendingPull = true;
	
	/** @type {Set<Function>} Set of listener callbacks to invoke on get if pendingPull=true */
	#pullListeners = new Set();
	
	/** @type {WeakMap<Promise,any>} A WeakMap of handled promises, so multiple changes don't get triggered, also to record the previous value */
	#handlingPromises = new WeakMap();
	
	/**
	 * Constructs a new signalInstance.
	 * 
	 * @param {signalController} signalCtrl - The parent signal controller
	 * @param {any} value - Initial signal value
	 * @param {boolean} [useWeakRef=false] - Use WeakRef for object values
	 */
	constructor(signalCtrl,value,useWeakRef=false){
		let isPrimitive = value!==Object(value);
		// Check weakmap / cache to re-use existing signal
		if(!isPrimitive && signalsMap.has(value)) return signalsMap.get(value); 
		// Re-use existing signal if value is a signalProxy or signalInstance
		let resolved = resolveSignal(value,null,true);
		if(resolved instanceof signalInstance) return resolved;
		// Cofigure new signal
		this.#ctrl = signalCtrl; this.#useWeakRef = useWeakRef && !!window.WeakRef;
		if(value instanceof Promise || typeof value?.then==="function" || value instanceof signalInstance) this.set(value);
		else this.#setInner(value);
		this.#isGetting = false;
		Object.seal(this);
		// If non-primitive, add signal to weakmap / cache
		if(!isPrimitive) signalsMap.set(value,this);
	}
	
	/**
	 * Get parent signalController
	 * 
	 * @return {signalController} The signalController
	 */
	get ctrl(){ return this.#ctrl; }
	
	/**
	 * Internal getter/setter for the signal value.
	 * 
	 * The getter returns the dereferenced WeakRef value, otherwise the raw value.
	 * The setter stores the value, either as a WeakRef (useWeakRef=true), or as the raw value.
	 * 
	 * @returns {any} The current signal value
	 * @param {any} v - The value to store
	 * @private
	 */
	get #value(){ return (this.#useWeakRef && this.#isObject) ? this.#_value?.deref() : this.#_value; }
	set #value(v){ this.#isObject=(v===Object(v)); this.#_value = (this.#useWeakRef && this.#isObject) ? new WeakRef(v) : v; }
	
	/**
	 * Internal getter/setter for the Promise.
	 *
	 * The getter returns the dereferenced WeakRef Promise, otherwise the raw Promise.
	 * 
	 * The setter stores the Promise, either as a WeakRef (useWeakRef=true), or as the raw Promise.
	 * 
	 * @returns {Promise} The current Promise
	 * @param {Promise} v - The Promise to store
	 * @private
	 */
	get #promise(){ return this.#useWeakRef ? this.#_promise?.deref() : this.#_promise; }
	set #promise(v){ this.#_promise = v; }
	
	/**
	 * Internal function to set the signal value without triggering change notifications.
	 * 
	 * This method bypasses the normal observer notification flow, allowing internal state changes
	 * without cascading updates. It also resets the #pendingPull flag since a new value has been set.
	 * 
	 * @param {any} v - The value to set
	 * @private
	 */
	#setInner(v){
		this.#pendingPull = false;
		if(this.#value!==v) this.#value = v;
	}
	
	/**
	 * Invalidates the signal for PULL-based computed signals.
	 * 
	 * In PULL-based reactive patterns, observers request fresh values only when they need them.
	 * This method marks the signal as needing recomputation so that subsequent reads will trigger
	 * listener callbacks to refresh dependent computations.
	 */
	invalidatePull(){ this.#pendingPull = true; }
	
	/**
	 * Adds a listener callback that is invoked on each signal read (for PULL-based compute signals only)
	 * 
	 * Pull listeners are called when the signal is read AND the signal has been invalidated via invalidatePull().
	 * This creates a lazy evaluation pattern where computations only happen when needed.
	 * 
	 * @param {Function} fn - Listener callback function
	 */
	addPullListener(fn){ this.#pullListeners.add(fn); }
	
	/**
	 * Subscribes to signal updates with a listener callback.
	 * 
	 * This method creates a {@link signalObserver} instance and registers the provided callback.
	 * The listener & observer can be deactivated by calling observer.clear().
	 * 
	 * @param {Function} fn - Listener callback function to invoke on signal changes
	 * @returns {signalObserver} The signal signalObserver instance
	 */
	subscribe(fn){
		let obs = this.#ctrl.createObserver();
		obs.addListener(fn);
		return obs;
	}
	
	/**
	 * Records this signal to any currently recording observers.
	 * 
	 * When an observer is in "recording mode", accessing a signal causes that signal to be recorded as a dependency on the observer.
	 * 
	 * This method is automatically called internally by {@link get}.
	 * @see {@link signalObserver}
	 */
	record(){ this.#ctrl.triggerRecording(this); }
	
	/**
	 * Notifies all observers that have this signal recorded as a dependency.
	 * 
	 * The change notification goes through the controller, to the observers that depend on this signal.
	 * The observer itself will then invoke its listeners. If the observer is for a computed signal, that then gets updated (PUSH-based), or invalidated (PULL-based).
	 * 
	 * This method is automatically called internally by {@link set}.
	 * 
	 * @param {any} [oldValue] - The old value to pass to observers
	 * @see {@link signalObserver}
	 */
	changed(oldValue=void 0){
		this.#ctrl.triggerChange(this,oldValue,this.#value);
	}
	
	/**
	 * Notifies all observers that have this signal recorded as a dependency, for promises.
	 * 
	 * This method calls {@link changed} if this signal's value is still the same promise.
	 * 
	 * @param {any} promise The original promise
	 */
	#changedPromise(promise){
		if(!this.#handlingPromises.has(promise)) return;
		let oldValue = this.#handlingPromises.get(promise);
		if(promise===this.#promise) this.changed(oldValue);
		this.#handlingPromises.delete(promise);
	}
	
	/**
	 * Gets the signal value silently without any observers being involved.
	 * 
	 * @returns {any} The current signal value
	 */
	getSilent(){ return this.#value; }
	
	/**
	 * Gets the signal value, and triggers recording observers.
	 * 
	 * If this is a PULL-based compute signal, and if it has been invalidated ({@link invalidatePull}), the value will be computed during this method.
	 * 
	 * @returns {any} The current signal value
	 * @see {@link signalObserver}
	 * @see {@link signalController.computeSignalPull}
	 */
	get(){
		if(this.#isGetting) return this.#value;
		this.#isGetting = true;
		this.record();
		if(this.#pendingPull) for(let listener of this.#pullListeners) try{ listener(); }catch(err){ console.error(err); }
		this.#isGetting = false;
		return this.#value;
	}
	
	/**
	 * Sets the signal value, and notifies all observers that have this signal recorded as a dependency.
	 * 
	 * This method calls {@link changed} which propagates the updated signal value.
	 * 
	 * If the value is a Promise, the change is invoked when the promise is fulfilled (if this signal's value remains as the same promise).
	 * If it's already fulfilled, the change will simply be deferred.
	 * 
	 * @param {any} value - The new value to set (can be any type, including Promise)
	 * @returns {boolean|undefined} Returns true if it's changing to a new value, otherwise false if it's already that value.
	 * @see {@link signalObserver}
	 * @see {@link changed}
	 */
	set(value){
		if(value instanceof signalInstance) value = value.get();
		let oldValue = this.#value;
		if(oldValue===value) return false;
		if(isPromise(value)){
			if(this.#promise===value) return false;
			this.#setInner(value);
			this.#promise = value;
			if(!this.#handlingPromises.has(value)){
				let boundFn = this.#changedPromise.bind(this,value);
				value.then(boundFn,boundFn);
			}
			this.#handlingPromises.set(value,oldValue);
		}
		else {
			if(this.#promise!==void 0) this.#promise = void 0;
			this.#setInner(value);
			this.changed(oldValue);
		}
		return true;
	}
	
	/**
	 * Property accessor that delegates to get()/set().
	 * 
	 * Instead of calling signal.get() or signal.set(value), you can use signal.value directly.
	 * 
	 * @returns {any} The current signal value
	 * @param {any} value - The new value to set
	 */
	get value(){ return this.get(); }
	set value(value){ this.set(value); }
	
	/**
	 * Returns the signal's value as a string.
	 * 
	 * Delegates to the value's toString() method if available.
	 * 
	 * @returns {string} The signal's value as a string, or undefined if value.toString doesn't exist
	 */
	get toString(){ let v=this.get(); return v?.toString?.bind(v); }
	
	/**
	 * Returns the signal's value as a locale-specific string.
	 * 
	 * Delegates to the value's toLocaleString() method if available.
	 * 
	 * @returns {string} signal's value as a locale-specific string, or undefined if value.toLocaleString doesn't exist
	 */
	get toLocaleString(){ let v=this.get(); return v?.toLocaleString?.bind(v); }
	
	/**
	 * Returns the signal's value as JSON.
	 * 
	 * Delegates to the value's toJSON() method if available.
	 * 
	 * @returns {any} The signal's value as JSON, or undefined if value.toJSON doesn't exist
	 */
	get toJSON(){ let v=this.get(); return v?.toJSON?.bind(v); }
	
	/**
	 * Returns the signal's value as a primitive.
	 * 
	 * Delegates to the value's valueOf() method if available.
	 * 
	 * @returns {any} The signal's value as a primitive, or the raw value itself if value.valueOf doesn't exist
	 */
	valueOf(){ let v=this.get(); return v?.valueOf?v?.valueOf?.(v):v; }
	
	/**
	 * Allows the signal to be used with the Promise method .then().
	 * 
	 * By implementing then(), signals become "thenable" and can be treated as Promises, including with await.
	 * 
	 * @param {Function} resolve - Promise resolve callback
	 * @param {Function} [reject] - Promise reject callback
	 * @returns {Promise} A Promise that contains the signal's value
	 */
	then(resolve,reject=void 0){ return Promise.resolve(this.get()).then(resolve,reject); }
	
	/**
	 * Returns the string tag for the signal.
	 * 
	 * Returns the value's Symbol.toStringTag if available, otherwise returns "ScopeDom.signalInstance".
	 * 
	 * @returns {string} The value's Symbol.toStringTag, otherwise returns "ScopeDom.signalInstance"
	 */
	get [Symbol.toStringTag](){ return this.get()?.[Symbol.toStringTag] || "ScopeDom.signalInstance"; }
	
	/**
	 * Returns an iterator for the signal's value.
	 * 
	 * Delegates to the value's Symbol.iterator method if available, enabling for...of loops.
	 * 
	 * @returns {Iterator} An iterator for the signal's value, or undefined if value[Symbol.iterator] doesn't exist
	 */
	[Symbol.iterator](){ return Iterator.from ? Iterator.from(this.get()) : this.get()?.[Symbol.iterator]?.(); }
	
	/**
	 * Converts the signal's value to a primitive type.
	 * 
	 * This method implements Symbol.toPrimitive, which JavaScript calls during operations like:
	 * - String conversion (e.g., `+value`, `${value}`)
	 * - Numeric conversion (e.g., `value + 0`)
	 * - Comparison operators (e.g., value == 42)
	 * 
	 * The hint parameter indicates the desired primitive type per ECMAScript spec:
	 * - 'default': Used for == operator, returns value as-is
	 * - 'string': Returns string representation via template literal `${v}`
	 * - 'number': Returns numeric value via unary plus +v
	 * 
	 * Delegates to the value's Symbol.toPrimitive method if available.
	 * 
	 * For unknown hints, a console.info warning is logged for debugging purposes.
	 * 
	 * @param {string} hint - The desired primitive type ('default', 'string', or 'number')
	 * @returns {any} The converted primitive value (type depends on hint), or undefined if unknown hint
	 */
	[Symbol.toPrimitive](hint){
		let v=this.get(), fn=v?.[Symbol.toPrimitive];
		if(fn) return fn(hint);
		if(hint==='default') return v;
		if(hint==='string') return `${v}`;
		if(hint==='number') return +v;
		console.info('ScopeDom.signalInstance [Symbol.toPrimitive](hint) Unknown hint:',hint);
	}
	
}
