
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

/**
 * Signal Instance - the basic reactive value unit of the signal system.
 * 
 * A signalInstance is the atomic unit of reactivity. It holds a single `value`
 * (which can be any type including Promise) with getter/setter access, can be
 * subscribed to via a signalObserver, and supports async value resolution - when
 * the signal's value is a Promise, the controller receives a change notification
 * only when the Promise is fulfilled (rather than synchronously on every set).
 * 
 * Internally, the signal uses WeakRef when `useWeakRef` is true, which allows
 * the GC to reclaim the referenced value object if the signal is no longer
 * accessible, minimising memory leaks in long-running applications.
 * 
 * The signal also supports PULL-based computed patterns: a signal can be
 * invalidated via {@link invalidatePull}, and pull listeners added via
 * {@link addPullListener} will be invoked on each {@link get} call, enabling
 * lazy evaluation where computations only happen when the value is actually needed.
 * 
 * Type helpers implement standard JavaScript semantics: `then()` makes the signal
 * itself thenable, `valueOf()`, `Symbol.iterator`, and `[Symbol.toStringTag]` are
 * delegated to the underlying value.
 * However these are discouraged for regular use, as the developer should be aware
 * of if the value type is a signalInstance or the raw value itself. These helpers
 * may be removed in future versions.
 * 
 * @see {@link signalController} - Signal Controller for managing signals and observers
 * @see {@link signalObserver} - Signal Observer for tracking signal dependencies
 * @see {@link signalProxy} - Signal Proxy for deep reactivity for objects with automatic signal tracking
 * 
 * @class signalInstance
 * @property {signalController} ctrl - The parent signal controller managing this instance's lifecycle and notification callbacks
 * @property {any} value - The current signal value (also accessible via get()/set())
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
	
	/** @type {Function|null} Custom equality function */
	#equalsFn = null;
	
	/** @type {boolean} Is value an object (not a primitive) */
	#isObject = false;
	
	/** @type {boolean} Is already in get() operation */
	#isGetting = true;
	
	/** @type {boolean} Is already in get() operation */
	#coalesceChanges = true;
	
	/** @type {boolean} If signal needs recomputation for PULL-based computed signals */
	#pendingPull = true;
	
	/** @type {Array<Function>} Array of listener callbacks to invoke on get if pendingPull=true */
	#pullListeners = [];
	
	/** @type {WeakMap<Promise,any>} A WeakMap of handled promises, so multiple changes don't get triggered, also to record the previous value */
	#handlingPromises = new WeakMap();
	
	/**
	 * Constructs a new signalInstance.
	 * 
	 * @param {signalController} signalCtrl The parent signal controller
	 * @param {any} value Initial signal value
	 * @param {object} [options={}] Configuration options
	 * @param {boolean} [options.useWeakRef=false] Use WeakRef for object values; value must be referenced elsewhere
	 * @param {Function} [options.equalsFn=null] Custom equality function, `(a, b, signal)`, returns boolean
	 */
	constructor(signalCtrl,value,options={}){
		let { useWeakRef, equalsFn, coalesceChanges } = options = { __proto__:null, useWeakRef:false, equalsFn:null, coalesceChanges:true, ...options };
		// Re-use existing signal if value is a signalProxy or signalInstance
		let resolved = resolveSignal(value,null,true);
		if(resolved instanceof signalInstance) return resolved;
		// Cofigure new signal
		this.#ctrl = signalCtrl; this.#useWeakRef = !!useWeakRef && !!window.WeakRef;
		this.#equalsFn = typeof equalsFn==="function" ? equalsFn : null;
		this.#coalesceChanges = !!coalesceChanges;
		if(value instanceof Promise || typeof value?.then==="function" || value instanceof signalInstance) this.set(value);
		else this.#setInner(value);
		this.#isGetting = false;
		Object.seal(this);
	}
	
	/**
	 * Get parent signalController
	 * 
	 * @returns {signalController} The signalController
	 */
	get ctrl(){ return this.#ctrl; }
	
	/**
	 * Internal getter/setter for the signal value.
	 * 
	 * The getter returns the dereferenced WeakRef value, otherwise the raw value.
	 * The setter stores the value, either as a WeakRef (useWeakRef=true), or as the raw value.
	 * 
	 * @private
	 * @returns {any} The current signal value
	 * @param {any} v The value to store
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
	 * @private
	 * @returns {Promise} The current Promise
	 * @param {Promise} v The Promise to store
	 */
	get #promise(){ return this.#useWeakRef ? this.#_promise?.deref() : this.#_promise; }
	set #promise(v){ this.#_promise = this.#useWeakRef ? new WeakRef(v) : v; }
	
	/**
	 * Internal function to set the signal value without triggering change notifications.
	 * 
	 * This method bypasses the normal observer notification flow, allowing internal state changes
	 * without cascading updates. It also resets the #pendingPull flag since a new value has been set.
	 * 
	 * This does NOT use `.equals` method.
	 * 
	 * @private
	 * @param {any} v The value to set
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
	invalidatePull(){
		this.#pendingPull = true;
	}
	
	/**
	 * Adds a listener callback that is invoked on each signal read (for PULL-based compute signals only)
	 * 
	 * Pull listeners are called when the signal is read AND the signal has been invalidated via invalidatePull().
	 * This creates a lazy evaluation pattern where computations only happen when needed.
	 * 
	 * @param {Function} fn Listener callback function
	 */
	addPullListener(fn){
		this.#pullListeners.push(fn);
	}
	
	/**
	 * Subscribes to signal updates with a listener callback.
	 * 
	 * This method creates a {@link signalObserver} instance and registers the provided callback.
	 * The listener & observer can be deactivated by calling observer.clear().
	 * 
	 * When `coalesceChanges:true` (default), the listener is invoked with: `( observer, signal, oldValue, newValue )`
	 * Otherwise when `false`, the listener is invoked with: `( observer, [ [ signal, oldValue, newValue ], ... ] )`
	 * 
	 * Changes are coalesced by default, see `coalesceChanges` in signal options.
	 * 
	 * @param {Function} fn Listener callback function to invoke on signal changes
	 * @returns {signalObserver} The signal signalObserver instance
	 */
	subscribe(fn){
		let obs = this.#ctrl.createObserver();
		obs.recordSignal(this);
		if(this.#coalesceChanges) obs.addListener((obs,[[signal,oldValue,newValue]])=>fn(obs,signal,oldValue,newValue));
		else obs.addListener(fn);
		return obs;
	}
	
	/**
	 * Records this signal to any currently recording observers.
	 * 
	 * When an observer is in "recording mode", accessing a signal causes that signal to be
	 * recorded as a dependency on the observer.
	 * 
	 * This method is automatically called internally by {@link get}.
	 * 
	 * @see {@link signalObserver}
	 */
	record(){
		this.#ctrl.triggerRecording(this);
	}
	
	/**
	 * Notifies all observers that have this signal recorded as a dependency.
	 * 
	 * The change notification goes through the controller, to all dependent observers.
	 * The observer itself will then invoke its listeners. If the observer is for a computed signal,
	 * the signal then gets updated (PUSH-based), or invalidated (PULL-based).
	 * 
	 * This method is automatically called internally by {@link set}.
	 * 
	 * @see {@link signalObserver}
	 * 
	 * @param {any} [oldValue] The old value to pass to observers
	 * @param {any} [newValue] The new value to pass to observers
	 */
	changed(oldValue=void 0,newValue=this.#value){
		if(newValue===this.#ctrl.symbolComputePullChange) newValue = void 0;
		this.#ctrl.triggerChange(this,oldValue,newValue,this.#coalesceChanges);
	}
	
	/**
	 * Notifies all observers that have this signal recorded as a dependency, for promises.
	 * 
	 * This method calls {@link changed} if this signal's value is still the same promise.
	 * 
	 * @private
	 * @param {any} promise The original promise
	 * @param {any} result The resolve/reject result
	 */
	#changedPromise(promise,result){
		if(!this.#handlingPromises.has(promise)) return;
		let oldValue = this.#handlingPromises.get(promise);
		if(this.equals(promise,this.#promise)) this.changed(oldValue);
		this.#handlingPromises.delete(promise);
	}
	
	/**
	 * Compares two signal values for deduplication purposes (also used internally).
	 * 
	 * Resolution order:
	 * 1. Custom {@link options.equalsFn} if provided, called with `(a, b, signal)`
	 * 2. `.equals()` method on either value (or its prototype)
	 * 3. Strict equality `a===b` (default)
	 * 
	 * This allows immutable value types (records, tuples, BigInt, custom objects with `.equals()`) to be deep-equal
	 * 
	 * @param {any} a First value
	 * @param {any} b Second value
	 * @returns {boolean} True if the values are considered equal
	 */
	equals(a,b){
		if(this.#equalsFn) return this.#equalsFn(a,b,this);
		if(typeof a?.equals==="function") return a.equals(b);
		if(typeof b?.equals==="function") return b.equals(a);
		return a===b;
	}
	
	/**
	 * Gets/Peeks the signal value silently without any dependancy-tracking / observers being involved.
	 * No PULL-based signals are computed either.
	 * 
	 * @returns {any} The current signal value
	 */
	getSilent(){ return this.#value; }
	
	/**
	 * Gets the signal value, and triggers recording observers.
	 * 
	 * If this is a PULL-based compute signal, and if it has been invalidated ({@link invalidatePull}), the value will be computed during this method.
	 * 
	 * @see {@link signalObserver}
	 * @see {@link signalController.computeSignalPull}
	 * 
	 * @returns {any} The current signal value
	 */
	get(){
		if(this.#isGetting) return this.#value;
		this.#isGetting = true;
		this.record();
		if(this.#pendingPull) for(let i=0,l=this.#pullListeners.length; i<l; i++){
			let listener = this.#pullListeners[i];
			try{ listener(); }catch(err){ console.error(err); }
		}
		this.#isGetting = false;
		return this.#value;
	}
	
	/**
	 * Sets the signal value, and notifies all observers that have this signal recorded as a dependency.
	 * 
	 * This method calls {@link changed} which propagates the updated signal value.
	 * 
	 * If the value is a Promise, the change is invoked when it fulfills - but only if this signal's value is still the same Promise reference.
	 * Re-setting the same Promise is a no-op and returns false (checked by reference, not by whether the Promise has already settled).
	 * 
	 * @see {@link signalObserver}
	 * @see {@link changed}
	 * 
	 * @param {any} value The new value to set (can be any type, including Promise)
	 * @returns {boolean} Returns true if it's changing to a new value, otherwise false if it's already that value.
	 */
	set(value){
		if(value instanceof signalInstance) value = value.get();
		let oldValue = this.#value;
		if(this.equals(oldValue,value)) return false;
		if(isPromise(value)){
			if(this.equals(this.#promise,value)) return false;
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
	 * @param {any} value The new value to set
	 */
	get value(){ return this.get(); }
	set value(value){ this.set(value); }
	
	/**
	 * Allows the signal to be used with the Promise method .then().
	 * 
	 * By implementing then(), signals become "thenable" and can be treated as Promises, including with await.
	 * 
	 * @param {Function} resolve Promise resolve callback
	 * @param {Function} [reject] Promise reject callback
	 * @returns {Promise} A Promise that contains the signal's value
	 */
	then(resolve,reject=void 0){ return Promise.resolve(this.get()).then(resolve,reject); }
	
}
