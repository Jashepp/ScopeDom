
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
	execExpression, execExpressionProxy,
} from "./exec.js";
import {
	scopeExpressionContext, scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "./scope.js";


export class signalController {
	
	#preventUpdates = false;
	#preventObservers = false;
	#observersRecording = new Set();
	#observers = new Set();
	
	constructor(scopeCtrl){
		if(scopeCtrl instanceof scopeElementController) scopeCtrl = scopeCtrl.ctrl;
		this.scopeCtrl = scopeCtrl;
	}
	
	createObserver(options={}){ let o=new signalObserver(this,options); this.#observers.add(o); return o; }
	
	removeObserver(observer,clear=true){
		if(!(observer instanceof signalObserver)) throw new TypeError("removeObserver observer must be a signalObserver");
		this.#observers.delete(observer); this.#observersRecording.delete(observer);
		if(clear) observer.clear();
	}
	
	startObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("startObserverRecording observer must be a signalObserver");
		this.#observersRecording.add(observer);
	}
	
	stopObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("stopObserverRecording observer must be a signalObserver");
		this.#observersRecording.delete(observer);
	}
	
	triggerChange(signal,oldValue,newValue){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerChange signal must be a signalInstance");
		if(!this.#preventUpdates) for(let observer of this.#observers) if(observer.hasSignal(signal)) observer.triggerChange(signal,oldValue,newValue);
	}
	
	triggerRecording(signal){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerRecording signal must be a signalInstance");
		if(!this.#preventObservers) for(let observer of this.#observersRecording) if(!observer.hasSignal(signal)) observer.recordSignal(signal);
	}
	
	/**
	 * Prevent existing observers from recording signals.
	 * However, allow nested observers to record, such as computed pull signals.
	 * @param {Function} fn Function to run
	 * @returns The wrapped function
	 */
	isolateRecording(fn){
		if(!(fn instanceof Function)) throw new TypeError("isolateRecording fn must be a Function (callback)");
		let self = this;
		return function signalIsolatedRecording(...args){
			let prev = [...self.#observersRecording];
			self.#observersRecording.clear();
			let result; try{ result=fn(...args); }catch(err){ console.error(err); }
			for(let observer of prev) self.#observersRecording.add(observer);
			return result;
		};
	}
	
	/**
	 * Prevent signals from triggering updates to observers during function execution.
	 * Additional parameters will be passed to the function.
	 * @param {Function} fn Function to run
	 * @returns The function's result, or thrown error
	 */
	preventUpdates(fn,...args){
		if(!(fn instanceof Function)) throw new TypeError("preventUpdates fn must be a Function (callback)");
		let result, error;
		this.#preventUpdates = true;
		try{ result=fn(...args); }catch(err){ error=err; }
		this.#preventUpdates = false;
		if(error) throw error;
		return result;
	}
	
	/**
	 * Prevent observers from recording signals during function execution.
	 * Additional parameters will be passed to the function.
	 * @param {Function} fn Function to run
	 * @returns The function's result, or thrown error
	 */
	preventObservers(fn,...args){
		if(!(fn instanceof Function)) throw new TypeError("preventObservers fn must be a Function (callback)");
		let result, error;
		this.#preventObservers = true;
		try{ result=fn(...args); }catch(err){ error=err; }
		this.#preventObservers = false;
		if(error) throw error;
		return result;
	}
	
	// Signal Helper Methods
	/**
	 * Create signalInstance & record it immediately to any recording signalObserver.
	 * @param {any} value Signal value
	 * @param {boolean=} useWeakRef Use WeakRef
	 * @returns {signalInstance}
	 */
	createSignal(value=void 0,useWeakRef=false){
		if(value instanceof Array) throw new TypeError("createSignal value is an Array, use proxySignal instead");
		if(value instanceof Map) throw new TypeError("createSignal value is a Map, use proxySignal instead");
		if(value instanceof Set) throw new TypeError("createSignal value is a Set, use proxySignal instead");
		let signal = new signalInstance(this,value,useWeakRef); signal.record();
		return signal;
	}
	
	/**
	 * Create signalInstance & record it immediately to any recording signalObserver.
	 * Also, define a getter/setter on the target object.
	 * @param {object} obj Target Object
	 * @param {string} prop Property Name
	 * @param {any=} value Signal Value
	 * @param {PropertyDescriptor|object=} descriptor Property descriptor options
	 * @param {boolean=} useOriginal Use original existing getter/setter
	 * @returns {signalInstance}
	 */
	defineSignal(obj,prop,value=void 0,descriptor={},useOriginal=true){
		let { configurable=true, enumerable=true, get:oGet=null, set:oSet=null } = { __proto__:null, ...descriptor };
		let signal = value instanceof signalInstance ? value : this.createSignal(value), sGet, sSet;
		if(useOriginal && oSet){
			if(oGet) sGet = function defineSignalGet(){ signal.set(oGet.apply(obj)); return signal.get(); };
			sSet = function defineSignalSet(v){ oSet.apply(obj,[v]); if(oGet){ v=oGet.apply(obj); } return signal.set(v); };
		}
		if(!sGet) sGet = signal.get.bind(signal); if(!sSet) sSet = signal.set.bind(signal);
		sGet[signalSymb] = sSet[signalSymb] = signal;
		defineProperty(obj,prop,{ __proto__:null, configurable, enumerable, get:sGet, set:sSet });
		return signal;
	}
	
	/**
	 * Create signalInstance & record it immediately to any recording signalObserver.
	 * Also, for each source property, define a getter/setter on the target object, as signals.
	 * @param {object} target Target Object
	 * @param {object} source Source Object
	 * @returns {object} Target Object
	 */
	assignSignals(target,source){
		for(let [key,val] of Object.entries(source)) this.defineSignal(target,key,val,getOwnPropertyDescriptor(source,key));
		return target;
	}
	
	/**
	 * Create a PUSH-based computed signal, which gets updated every time any of it's dependencies are updated.
	 * @param {Function} fn Callback to run when signalObserver is notified of a change. This signal's value will be set to the result of the callback.
	 * @param {object=} options { defer:true|false }
	 * @returns {Array<signalInstance,signalObserver,Function>} [ signalInstance, signalObserver, clear() ]
	 */
	computeSignalPush(fn,options={}){ // [ signal, observer, clear() ]
		if(!(fn instanceof Function)) throw new TypeError("computeSignalPush fn must be a Function (callback)");
		let signal = options?.signal || this.createSignal(void 0);
		let obs = this.createObserver(options);
		obs.signalsIgnore.add(signal);
		let recordingFn = this.isolateRecording(obs.wrapRecorder(fn));
		let runFn = function signalComputePushFn(){
			obs.clearSignals();
			signal.set(recordingFn());
		};
		obs.addListener(runFn);
		try{ runFn(obs,null); } catch(err){ console.error(err); }
		return [ signal, obs, obs.clear.bind(obs) ];
	}
	
	/**
	 * Create a PULL-based computed signal which only runs when this signal is read.
	 * @param {Function} fn Callback to run when computing this signal's read.
	 * @param {object=} options { defer:true|false }
	 * @returns {Array<signalInstance,signalObserver,Function>} [ signalInstance, signalObserver, clear() ]
	 */
	computeSignalPull(fn,options={}){ // [ signal, observer, clear() ]
		if(!(fn instanceof Function)) throw new TypeError("computeSignalPull fn must be a Function (callback)");
		let signal = options?.signal || this.createSignal(void 0);
		let obs = this.createObserver(options);
		obs.signalsIgnore.add(signal);
		let isUpdating = false;
		let updateFn = function signalUpdate(){
			if(isUpdating) return;
			isUpdating = true;
			signal.invalidatePull();
			signal.markChanged();
			isUpdating = false;
		};
		let recordingFn = this.isolateRecording(obs.wrapRecorder(fn));
		signal.addPullListener(function signalComputePullFn(){
			obs.clearSignals();
			signal.set(recordingFn());
		});
		obs.addListener(updateFn);
		signal.invalidatePull();
		return [ signal, obs, obs.clear.bind(obs) ];
	}
	
	/**
	 * Create a computed signal. Either push or pull (default).
	 * PUSH-based computed signals run every time any of its dependencies are updated.
	 * PULL-based computed signals only run when the signal is read.
	 * @param {Function} fn Compute callback
	 * @param {object=} options { pull:true|false }
	 * @returns {Array<signalInstance,signalObserver,Function>} [ signalInstance, signalObserver, clear() ]
	 */
	computeSignal(fn,options={}){
		options = { __proto__:null, pull:true, ...options };
		if(options.pull) return this.computeSignalPull(fn,options);
		else return this.computeSignalPush(fn,options);
	}
	
	/**
	 * Create signalProxy which creates a signalInstance & signalProxy for every property accessed. Infinitely deep.
	 * @param {any} value Object to proxy
	 * @param {signalInstance=} signal signalInstance for passed in value (auto-created)
	 * @param {boolean=} useWeakRef Use WeakRef - defaults to false here, and true on every deep/further signalProxy
	 * @returns {any} Proxy of passed in value
	 */
	proxySignal(value,signal=null,useWeakRef=false){
		if(value!==Object(value)) throw new TypeError("proxySignal root value must not be a primitive");
		return new signalProxy(value,this,signal,useWeakRef);
	}
	
	/**
	 * Create signalProxy which creates a signalInstance & signalProxy for every property accessed. Infinitely deep.
	 * Also, define a getter/setter on the target object.
	 * @param {object} obj Target Object
	 * @param {string} prop Property Name
	 * @param {any=} value Signal Value
	 * @param {signalInstance=} signal signalInstance for passed in value (auto-created)
	 * @returns {any} Proxy of passed in value
	 */
	defineProxySignal(obj,prop,value,signal=null){
		if(value!==Object(value)) throw new TypeError("defineProxySignal root value must not be a primitive, try defineSignal instead");
		if(!signal) signal = new signalInstance(this,value);
		let proxy = new signalProxy(value,this,signal);
		let sGet = ()=>(signal.record(),proxy), sSet = (v)=>{ this.defineProxySignal(obj,prop,v,signal); };
		sGet[signalSymb] = sSet[signalSymb] = signal;
		defineProperty(obj,prop,{ __proto__:null, configurable:true, enumerable:true, get:sGet, set:sSet });
		return signal.record(), signal.set(proxy), proxy;
	}
	
}

export class signalObserver {
	
	constructor(signalCtrl,options={}){
		options = { __proto__:null, defer:signalCtrl?.ScopeDomInstance?.options?.signalDefer, ...options };
		this.ctrl = signalCtrl;
		this.signals = new WeakSet();
		this.signalsIgnore = new WeakSet();
		this.listeners = new Set();
		this.isRecording = false;
		this.isChanging = false;
		this.deferChange = options.defer===true || options.defer===void 0;
		this.isDeferring = false;
	}
	
	hasSignal(signal){ return this.signals.has(signal); }
	
	recordSignal(signal){
		if(!this.signals.has(signal) && !this.signalsIgnore.has(signal)) this.signals.add(signal);
	}
	
	triggerChange(signal,oldValue,newValue){
		if(this.isRecording || !this.signals.has(signal)) return;
		let self=this;
		function signalObserverListener(fn){ fn(self,signal,oldValue,newValue); };
		function signalObserverTrigger(){
			self.isDeferring = false;
			if(self.isChanging || self.listeners.size===0) return;
			self.isChanging = true;
			for(let fn of self.listeners) try{ signalObserverListener(fn); } catch(err){ console.error(err); }
			self.isChanging = false;
		}
		if(!this.deferChange) return signalObserverTrigger();
		if(this.isDeferring) return;
		this.isDeferring = true;
		deferFn(signalObserverTrigger);
	}
	
	startRecording(){
		if(this.isRecording) return false;
		this.isRecording = true;
		this.ctrl.startObserverRecording(this);
		return true;
	}
	
	stopRecording(){
		if(!this.isRecording) return false;
		this.isRecording = false;
		this.ctrl.stopObserverRecording(this);
		return true;
	}
	
	wrapRecorder(fn){
		let self = this;
		return function signalObserverRecorder(...args){
			let recording = self.startRecording();
			let result; try{ result=fn(...args); }catch(err){ console.error(err); }
			if(recording) self.stopRecording();
			return result;
		};
	}
	
	addListener(fn){ this.listeners.add(fn); return this.removeListener.bind(this,fn); }
	removeListener(fn){ this.listeners.delete(fn); }
	clear(){ this.listeners.clear(); this.signals=new WeakSet(); this.ctrl.removeObserver(this,false); }
	clearSignals(){ this.signals=new WeakSet(); }
}

if(Symbol.dispose) signalObserver.prototype[Symbol.dispose] = signalObserver.prototype.clear;

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
			if(target instanceof Array && prop===Symbol.iterator) targetSignal.record();
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
			return targetSignal.markChanged(), result;
		}, true ];
		else if(wrapRecordFn) return [ function signalProxyFnWrapperRecord(...args){
			return signalProxy.apply({ target:getValue, targetSignal, signalCtrl },target,args);
		}, true ];
		return [ getValue, false ];
	}
	static _handleTypesSet(obj,prop,getValue,value){
		let { target, targetSignal, isIterable } = obj;
		if(isIterable && targetSignal && target instanceof Array && prop==='length') targetSignal.markChanged();
		else if(isIterable && targetSignal && prop*1>=0) targetSignal.markChanged();
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

export const signalSymb = Symbol('$signalInstance');
export class signalInstance {
	
	/** @type {signalController} */
	#ctrl; #isGetting=true;
	#_value; #_promise; #useWeakRef=false; #isObject=false;
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
	set #promise(v){ this.#_promise = new WeakRef(v); }
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
	
	record(){ this.#ctrl.triggerRecording(this); }
	markChanged(){
		let oldValue = this.#value;
		this.#ctrl.triggerChange(this,oldValue,oldValue);
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
			newValue.then(this.#ctrl.triggerChange.bind(this.#ctrl,this,oldValue,newValue),this.#ctrl.triggerChange.bind(this.#ctrl,this,oldValue,newValue));
		}
		else {
			if(oldPromise!==void 0) this.#promise = void 0;
			this.#setFn(newValue);
			this.#ctrl.triggerChange(this,oldValue,newValue);
		}
	}
	
	get value(){ return this.get(); }
	set value(v){ this.set(v); }
	get toString(){ let v=this.get(); return v?.toString?.bind(v); }
	get toLocaleString(){ let v=this.get(); return v?.toLocaleString?.bind(v); }
	get toJSON(){ let v=this.get(); return v?.toJSON?.bind(v); }
	valueOf(){ return this.get(); }
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
