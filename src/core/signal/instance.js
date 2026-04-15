
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

export class signalInstance {
	
	/** @type {signalController} */
	#ctrl;
	/** Internal values */
	#_value; #_promise;
	/** Internal flags */
	#useWeakRef=false; #isObject=false; #isGetting=true;
	/** Pull-based functionality */
	#pendingPull=true; #pullListeners=new Set();
	
	constructor(signalCtrl,value,useWeakRef=false){
		this.#ctrl = signalCtrl; this.#useWeakRef = useWeakRef && !!window.WeakRef;
		if(value instanceof Promise || typeof value?.then==="function" || value instanceof signalInstance) this.set(value);
		else this.#setFn(value);
		this.#isGetting = false;
	}
	
	get #value(){ return (this.#useWeakRef && this.#isObject) ? this.#_value?.deref() : this.#_value; }
	set #value(v){ this.#isObject=(v===Object(v)); this.#_value = (this.#useWeakRef && this.#isObject) ? new WeakRef(v) : v; }
	
	get #promise(){ return this.#useWeakRef ? this.#_promise?.deref() : this.#_promise; }
	set #promise(v){ this.#_promise = v; }
	
	#setFn = function signalSetInner(v){
		this.#pendingPull = false;
		if(this.#value!==v) this.#value = v;
	}
	
	/** Invalidate this signal for computeSignalPull */
	invalidatePull(){ this.#pendingPull = true; }
	/** Listen callbacks for each get (excluding getSilent) */
	addPullListener(fn){ this.#pullListeners.add(fn); }
	
	/**
	 * Subscribe to updates, directly to this Signal only.
	 * If this listener is no longer needed, be sure to run observer.clear()
	 * @param {Function} fn Listener callback
	 * @param {boolean} defer Defer (Promise.then) listener execution
	 * @returns {signalObserver} Signal Observer only for this listener
	 */
	subscribe(fn,defer=this.#ctrl?.ScopeDomInstance?.options?.signalDefer){
		defer = defer===true || defer===void 0;
		let obs = this.#ctrl.createObserver({ defer });
		obs.addListener(fn);
		return obs;
	}
	
	record = function signalRecord(){ this.#ctrl.triggerRecording(this); }
	
	changed = function signalChanged(pending=false,oldValue=void 0){
		if(oldValue===void 0) oldValue = this.#value;
		this.#ctrl.triggerChange(this,oldValue,this.#value);
	}
	
	getSilent(){ return this.#value; }
	
	get = function signalGet(){
		if(this.#isGetting) return this.#value;
		this.#isGetting = true;
		this.#ctrl.triggerRecording(this);
		if(this.#pendingPull) for(let listener of this.#pullListeners) try{ listener(); }catch(err){ console.error(err); }
		this.#isGetting = false;
		return this.#value;
	}
	
	set = function signalSet(v){
		if(v instanceof signalInstance) v = v.get();
		let oldValue = this.#value, newValue = v;
		if(oldValue===newValue) return;
		let oldPromise = this.#promise, isPromise = (v instanceof Promise || typeof v?.then==="function");
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
	
	get value(){ return this.get(); }
	set value(v){ this.set(v); }
	
	get toString(){ let v=this.get(); return v?.toString?.bind(v); }
	
	get toLocaleString(){ let v=this.get(); return v?.toLocaleString?.bind(v); }
	
	get toJSON(){ let v=this.get(); return v?.toJSON?.bind(v); }
	
	valueOf(){ let v=this.get(); return v?.valueOf?v?.valueOf?.(v):v; }
	
	then(res,rej=void 0){ return Promise.resolve(this.get()).then(res,rej); }
	
	get [Symbol.toStringTag](){ return this.get()?.[Symbol.toStringTag] || "ScopeDom.signalInstance"; }
	
	[Symbol.iterator](){ return this.get()?.[Symbol.iterator]?.(); }
	
	[Symbol.toPrimitive](hint){
		let v=this.get(), fn=v?.[Symbol.toPrimitive];
		if(fn) return fn(hint);
		if(hint==='default') return v;
		if(hint==='string') return `${v}`;
		if(hint==='number') return +v;
		console.info('ScopeDom.signalInstance [Symbol.toPrimitive](hint) Unknown hint:',hint);
	}
	
}

