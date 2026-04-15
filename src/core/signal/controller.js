
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

import { signalObserver } from "./observer.js";
import { signalInstance, signalSymb } from "./instance.js";
import { signalProxy, resolveSignal } from "./proxy.js";

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
