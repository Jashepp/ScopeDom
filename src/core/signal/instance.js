
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
import { signalProxy, resolveSignal } from "./proxy.js";

export const signalSymb = Symbol('$signalInstance');

/**
 * SignalInstance - Represents a reactive signal value.
 * @class signalInstance
 * @prop {signalController} ctrl - The parent signal controller
 * @prop {any} value - The current signal value
 */
export class signalInstance {
	
	/** @type {signalController} */
	#ctrl;
	/** Internal values */
	#_value; #_promise;
	/** Internal flags */
	#useWeakRef=false; #isObject=false; #isGetting=true;
	/** Pull-based functionality */
	#pendingPull=true; #pullListeners=new Set();
	
	/**
	 * Constructs a new signalInstance.
	 * @param {signalController} signalCtrl - The parent signal controller
	 * @param {any} value - Initial signal value
	 * @param {boolean} [useWeakRef=false] - Use WeakRef for object values
	 */
	constructor(signalCtrl,value,useWeakRef=false){
		this.#ctrl = signalCtrl; this.#useWeakRef = useWeakRef && !!window.WeakRef;
		if(value instanceof Promise || typeof value?.then==="function" || value instanceof signalInstance) this.set(value);
		else this.#setFn(value);
		this.#isGetting = false;
	}
	
	/**
	 * Get parent signalController
	 * @return {signalController} The signalController
	 */
	get ctrl(){ return this.#ctrl; }
	
	/**
	 * Internal getter/setter for the signal value.
	 *
	 * getter: Returns the dereferenced value if using WeakRef, otherwise returns the raw value.
	 * 
	 * setter: Stores the value, using WeakRef for object values when enabled.
	 * @returns {any} The current signal value
	 * @param {any} v - The value to set
	 */
	get #value(){ return (this.#useWeakRef && this.#isObject) ? this.#_value?.deref() : this.#_value; }
	set #value(v){ this.#isObject=(v===Object(v)); this.#_value = (this.#useWeakRef && this.#isObject) ? new WeakRef(v) : v; }
	
	/**
	 * Internal getter/setter for the Promise.
	 *
	 * getter: Stores the Promise using WeakRef.
	 * 
	 * setter: Returns the dereferenced Promise if using WeakRef, otherwise returns the raw Promise.
	 * @returns {Promise} The pending Promise
	 * @param {Promise} v - The Promise to store
	 */
	get #promise(){ return this.#useWeakRef ? this.#_promise?.deref() : this.#_promise; }
	set #promise(v){ this.#_promise = v; }
	
	/**
	 * Internal function to set the signal value without triggering change notifications.
	 * @param {any} v - The value to set
	 */
	#setFn = function signalSetInner(v){
		this.#pendingPull = false;
		if(this.#value!==v) this.#value = v;
	}
	
	/**
	 * Invalidates the signal for PULL-based computed signals.
	 *
	 * Marks the signal as needing recomputation.
	 */
	invalidatePull(){ this.#pendingPull = true; }
	
	/**
	 * Adds a listener callback that is invoked on each signal read.
	 *
	 * Pull listeners are called when the signal is read and the signal has been invalidated via invalidatePull().
	 * @param {Function} fn - Listener callback function
	 */
	addPullListener(fn){ this.#pullListeners.add(fn); }
	
	/**
	 * Subscribes to signal updates with a listener callback, using a new signalObserver.
	 * 
	 * The observer can be unsubscribed by calling observer.clear().
	 * @param {Function} fn - Listener callback function
	 * @param {boolean} [defer=this.#ctrl?.ScopeDomInstance?.options?.signalDefer] - Defer listener execution
	 * @returns {signalObserver} A signalObserver instance for this listener
	 */
	subscribe(fn,defer=this.#ctrl?.ScopeDomInstance?.options?.signalDefer){
		defer = defer===true || defer===void 0;
		let obs = this.#ctrl.createObserver({ defer });
		obs.addListener(fn);
		return obs;
	}
	
	/**
	 * Records this signal to any currently recording observers.
	 */
	record = function signalRecord(){ this.#ctrl.triggerRecording(this); }
	
	/**
	 * Notifies all observers that has this signal recorded.
	 * 
	 * Don't need defer logic here, it's in signalObserver instead.
	 * @param {boolean} [pending=false] - Defer change notification
	 * @param {any} [oldValue] - The new value to set
	 */
	changed = function signalChanged(pending=false,oldValue=void 0){
		if(oldValue===void 0) oldValue = this.#value;
		this.#ctrl.triggerChange(this,oldValue,this.#value);
	}
	
	/**
	 * Gets the signal value silently without any observers being involved.
	 * @returns {any} The current signal value
	 */
	getSilent(){ return this.#value; }
	
	/**
	 * Gets the signal value and trigger recording observers.
	 * @returns {any} The current signal value
	 */
	get = function signalGet(){
		if(this.#isGetting) return this.#value;
		this.#isGetting = true;
		this.#ctrl.triggerRecording(this);
		if(this.#pendingPull) for(let listener of this.#pullListeners) try{ listener(); }catch(err){ console.error(err); }
		this.#isGetting = false;
		return this.#value;
	}
	
	/**
	 * Sets the signal value and notifies all observers that has this signal recorded.
	 * @param {any} v - The new value to set
	 */
	set = function signalSet(v){
		if(v instanceof signalInstance) v = v.get();
		let oldValue = this.#value, newValue = v;
		if(oldValue===newValue) return;
		let oldPromise = this.#promise, isPromise = (v instanceof Promise || ('then' in Object(v) && typeof v?.then==="function"));
		if(isPromise){
			if(oldPromise===newValue) return;
			this.#setFn(newValue);
			this.#promise = newValue;
			newValue.then(this.changed.bind(this,false,oldValue),this.changed.bind(this,false,oldValue));
		}
		else {
			if(oldPromise!==void 0) this.#promise = void 0;
			this.#setFn(newValue);
			this.changed(false,oldValue);
		}
	}
	
	/**
	 * Property accessor that delegates to get()/set().
	 *
	 * Provides a more conventional property access syntax for signals.
	 * @returns {any} The current signal value
	 * @param {any} v - The new value to set
	 */
	get value(){ return this.get(); }
	set value(v){ this.set(v); }
	
	/**
	 * Returns the signal's value as a string.
	 *
	 * Delegates to the value's toString() method if available.
	 * @returns {string} The string representation of the signal's value
	 */
	get toString(){ let v=this.get(); return v?.toString?.bind(v); }
	
	/**
	 * Returns the signal's value as a locale-specific string.
	 *
	 * Delegates to the value's toLocaleString() method if available.
	 * @returns {string} The locale-specific string representation
	 */
	get toLocaleString(){ let v=this.get(); return v?.toLocaleString?.bind(v); }
	
	/**
	 * Returns the signal's value as JSON.
	 *
	 * Delegates to the value's toJSON() method if available.
	 * @returns {any} The JSON representation of the signal's value
	 */
	get toJSON(){ let v=this.get(); return v?.toJSON?.bind(v); }
	
	/**
	 * Returns the signal's value as a primitive.
	 *
	 * Delegates to the value's valueOf() method if available.
	 * @returns {any} The signal's value
	 */
	valueOf(){ let v=this.get(); return v?.valueOf?v?.valueOf?.(v):v; }
	
	/**
	 * Allows the signal to be used with the Promise method .then().
	 * 
	 * The signal's value is resolved as a Promise before invoking callbacks.
	 * @param {Function} res - Promise resolve callback
	 * @param {Function} [rej=void 0] - Promise Reject callback
	 * @returns {Promise} A Promise that resolves with the signal's value
	 */
	then(res,rej=void 0){ return Promise.resolve(this.get()).then(res,rej); }
	
	/**
	 * Returns the string tag for the signal.
	 *
	 * Returns the value's Symbol.toStringTag if available, otherwise returns "ScopeDom.signalInstance".
	 * @returns {string} The string tag
	 */
	get [Symbol.toStringTag](){ return this.get()?.[Symbol.toStringTag] || "ScopeDom.signalInstance"; }
	
	/**
	 * Returns an iterator for the signal's value.
	 *
	 * Delegates to the value's Symbol.iterator method if available.
	 * @returns {Iterator} An iterator for the signal's value
	 */
	[Symbol.iterator](){ return this.get()?.[Symbol.iterator]?.(); }
	
	/**
	 * Converts the signal's value to a primitive type.
	 *
	 * Delegates to the value's Symbol.toPrimitive method if available.
	 * Otherwise, converts based on the hint:
	 * - 'default': returns the value as-is
	 * - 'string': returns the string representation
	 * - 'number': returns the numeric value
	 * @param {string} hint - The desired primitive type ('default', 'string', or 'number')
	 * @returns {any} The converted primitive value
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

