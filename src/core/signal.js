
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
	constructor(scopeCtrl){
		if(scopeCtrl instanceof scopeElementController) scopeCtrl = scopeCtrl.ctrl;
		this.scopeCtrl = scopeCtrl;
		this.observers = new Set();
		this.observersRecording = new Set();
	}
	createObserver(options={}){ let o=new signalObserver(this,options); this.observers.add(o); return o; }
	removeObserver(observer,clear=true){
		this.observers.delete(observer); this.observersRecording.delete(observer);
		if(clear) observer.clear();
	}
	triggerChange(signal){
		for(let observer of this.observers) if(observer.hasSignal(signal)) observer.triggerChange(signal);
	}
	triggerRecording(signal){
		for(let observer of this.observersRecording) if(!observer.hasSignal(signal)) observer.recordSignal(signal);
	}
	isolateRecording(fn){
		let self = this;
		return function signalIsolatedRecording(...args){
			let prev = [...self.observersRecording];
			self.observersRecording.clear();
			let result; try{ result=fn(...args); }catch(err){ console.error(err); }
			for(let observer of prev) self.observersRecording.add(observer);
			return result;
		};
	}
	// Signal Helper Methods
	createSignal(value,useWeakRef=false){
		if(value instanceof Array) throw new TypeError("createSignal value is an Array, use proxySignal instead");
		if(value instanceof Map) throw new TypeError("createSignal value is a Map, use proxySignal instead");
		if(value instanceof Set) throw new TypeError("createSignal value is a Set, use proxySignal instead");
		let signal = new signalInstance(this,value,useWeakRef); signal.record();
		return signal;
	}
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
	assignSignals(target,source){
		for(let [key,val] of Object.entries(source)) this.defineSignal(target,key,val,getOwnPropertyDescriptor(source,key));
		return target;
	}
	computeSignal(fn,options={}){ // [ signal, observer, clear() ]
		let signal = this.createSignal(void 0);
		let obs = this.createObserver(options);
		obs.signalsIgnore.add(signal);
		let computeFn = this.isolateRecording(obs.wrapRecorder(fn));
		let runFn = function signalComputeFn(obs,trigger){ try{ signal.set(computeFn(trigger)); }catch(err){ console.error(err); } };
		obs.addListener(runFn);
		return runFn(), [ signal, obs, obs.clear.bind(obs) ];
	}
	proxySignal(value,signal=null,useWeakRef=false){
		if(value!==Object(value)) throw new TypeError("proxySignal root value must not be a primitive");
		return new signalProxy(value,this,signal,useWeakRef);
	}
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
		options = { __proto__:null, defer:signalCtrl?.scopeDomInstance?.options?.signalDefer, ...options };
		this.ctrl = signalCtrl;
		this.signals = new WeakSet();
		this.signalsIgnore = new WeakSet();
		this.listeners = new Set();
		this.isRecording = false;
		this.isChanging = false;
		this.hasChanged = false;
		this.deferChange = options.defer===true || options.defer===void 0;
		this.isDeferring = false;
	}
	hasSignal(signal){ return this.signals.has(signal); }
	recordSignal(signal){ if(!this.signals.has(signal) && !this.signalsIgnore.has(signal)) this.signals.add(signal); }
	triggerChange(signal){
		if(this.isRecording || !this.signals.has(signal)) return;
		this.hasChanged = true;
		let self=this;
		function signalObserverListener(fn){ try{ fn(self,signal); }catch(err){ console.error(err); } };
		function signalObserverTrigger(){
			self.isDeferring = false;
			if(self.isChanging || self.listeners.size===0) return;
			self.isChanging = true;
			for(let fn of self.listeners) signalObserverListener(fn);
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
		this.ctrl.observersRecording.add(this);
		return true;
	}
	stopRecording(){
		if(!this.isRecording) return false;
		this.isRecording = false;
		this.ctrl.observersRecording.delete(this);
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
	consumeHasChanged(){ let r=this.hasChanged; this.hasChanged=false; return r; }
	addListener(fn){ this.listeners.add(fn); return this.removeListener.bind(this,fn); }
	removeListener(fn){ this.listeners.delete(fn); }
	clear(){ this.listeners.clear(); this.signals=new WeakSet(); }
}

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
		if(!target) return console.warn("scopeDom signalProxy: has() called on proxy with gc'd target",{prop}), false;
		let hasProp = target && Reflect.has(target,prop);
		if(!hasProp && signals.get(prop)?.getSilent()!==void 0) signals.delete(prop);
		if(!hasProp && proxies.has(prop)) proxies.delete(prop);
		return hasProp;
	}
	static get = function signalProxyGet(obj,prop,receiver){
		let getValue, { target, targetSignal, proxies, signalCtrl } = obj;
		if(!target) return void console.warn("scopeDom signalProxy: get() called on proxy with gc'd target",{prop});
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
		if(!target) return console.warn("scopeDom signalProxy: set() called on proxy with gc'd target",{prop}), false;
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
		if(isIterable && targetSignal && prop*1>=0) targetSignal.record();
		if(isIterable && targetSignal && target instanceof Array && prop==='length') targetSignal.record();
		if(isIterable && targetSignal && target instanceof Map && prop==='size') targetSignal.record();
		if(isIterable && targetSignal && target instanceof Set && prop==='size') targetSignal.record();
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
		if(!target) return void console.warn("scopeDom signalProxy: deleteProperty() called on proxy with gc'd target",{prop});
		return proxies.delete(prop), signals.delete(prop), Reflect.deleteProperty(target,prop);
	}
	static construct(obj,argumentsList,newTarget){
		let { target, targetSignal, signalCtrl } = obj;
		if(!target) return void console.warn("scopeDom signalProxy: construct() called on proxy with gc'd target",{argumentsList});
		if(targetSignal) targetSignal.record();
		return new signalProxy(Reflect.construct(target,argumentsList,newTarget),signalCtrl);
	}
	static apply = function signalProxyApply(obj,thisArgument,argumentsList){
		let { target, targetSignal, signalCtrl } = obj;
		if(!target) return void console.warn("scopeDom signalProxy: apply() called on proxy with gc'd target",{thisArgument,argumentsList});
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
	#ctrl; #_value; #_promise; #isGetting=true; #isSetting=true; #useWeakRef=false; #isObject=false;
	constructor(signalCtrl,value,useWeakRef=false){
		this.#ctrl = signalCtrl; this.#useWeakRef = useWeakRef && !!window.WeakRef;
		this.#setFn(value);
		this.#isGetting = this.#isSetting = false;
	}
	get #value(){ return this.#useWeakRef && this.#isObject ? this.#_value?.deref() : this.#_value; }
	set #value(v){ this.#isObject=(v===Object(v)); this.#_value = this.#useWeakRef && this.#isObject ? new WeakRef(v) : v; }
	get #promise(){ return this.#useWeakRef ? this.#_promise?.deref() : this.#_promise; }
	set #promise(v){ this.#_promise = new WeakRef(v); }
	#setFn = function signalSetInner(v){
		if(v===this.#value) return;
		this.#value = v;
		let oldP = this.#promise;
		let isP = (v instanceof Promise || typeof v?.then==="function");
		if(!isP && oldP!==void 0) this.#promise = void 0;
		if(isP && oldP!==v){
			this.#promise = v;
			v.then(this.#ctrl.triggerChange.bind(this.#ctrl,this,v),this.#ctrl.triggerChange.bind(this.#ctrl,this));
		}
	}
	record(){ this.#ctrl.triggerRecording(this); }
	markChanged(){ this.#ctrl.triggerChange(this); }
	getSilent(){ return this.#value; }
	get = function signalGet(){
		if(this.#isGetting) return this.#value;
		this.#isGetting = true;
		this.#ctrl.triggerRecording(this);
		this.#isGetting = false;
		return this.#value;
	}
	set = function signalSet(v){
		if(this.#isSetting || v===this.#value) return;
		this.#setFn(v);
		this.#isSetting = true;
		this.#ctrl.triggerChange(this);
		this.#isSetting = false;
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
	}
}

export const resolveSignal = function(value,signalObs=null,strict=false){
	if(signalProxy._isProxy(value)) value = signalProxy._getProxySignal(value);
	if(value instanceof signalInstance){
		if(signalObs) signalObs.recordSignal(value);
		else value.record();
		value = value.get();
	}
	if(strict && !(value instanceof signalInstance)) return null;
	return value;
};
