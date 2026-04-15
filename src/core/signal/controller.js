
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

/**
 * Signal Controller for managing signals and observers.
 * @class signalController
 */
export class signalController {
	
	#preventUpdates = false;
	#preventObservers = false;
	#observersRecording = new Set();
	#observers = new Set();
	
	/**
	 * Constructs a new signalController with a reference to the parent scope controller.
	 * 
	 * If a scopeElementController is provided, it extracts the underlying signalController.
	 * @constructor
	 */
	constructor(scopeCtrl){
		if(scopeCtrl instanceof scopeElementController) scopeCtrl = scopeCtrl.ctrl;
		this.scopeCtrl = scopeCtrl;
	}
	
	/**
	 * Creates a new signalObserver instance.
	 * 
	 * Observers track which signals they depend on and can react to changes.
	 * @param {object} options - Observer configuration options
	 * @param {boolean} [options.defer=false] - Defer observer listener execution
	 * @returns {signalObserver} The newly created signalObserver instance
	 */
	createObserver(options={}){ let o=new signalObserver(this,options); this.#observers.add(o); return o; }
	
	/**
	 * Removes a signalObserver from the controller.
	 * @param {signalObserver} observer - The observer to remove
	 * @param {boolean} [clear=true] - Clear the observer's signals and listeners
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	removeObserver(observer,clear=true){
		if(!(observer instanceof signalObserver)) throw new TypeError("removeObserver observer must be a signalObserver");
		this.#observers.delete(observer); this.#observersRecording.delete(observer);
		if(clear) observer.clear();
	}
	
	/**
	 * Begins recording signals for a specific observer.
	 * 
	 * Signals accessed while an observer is in recording mode are tracked as dependencies.
	 * @param {signalObserver} observer - The observer to start recording for
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	startObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("startObserverRecording observer must be a signalObserver");
		this.#observersRecording.add(observer);
	}
	
	/**
	 * Stops recording signals for a specific observer.
	 * @param {signalObserver} observer - The observer to stop recording for
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	stopObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("stopObserverRecording observer must be a signalObserver");
		this.#observersRecording.delete(observer);
	}
	
	/**
	 * Triggers a change notification to all observers that have the given signal recorded.
	 * 
	 * Each observer's change listeners are then invoked, either immediately or deferred based on the observer's configuration.
	 * @param {signalInstance} signal - The signal that changed
	 * @param {any} oldValue - The previous value before the change
	 * @param {any} newValue - The new value after the change
	 * @throws {TypeError} If signal is not a signalInstance instance
	 */
	triggerChange(signal,oldValue,newValue){
		if(oldValue===void 0 && oldValue===newValue) oldValue = newValue = signal.getSilent();
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerChange signal must be a signalInstance");
		if(!this.#preventUpdates) for(let observer of this.#observers) if(observer.hasSignal(signal)) observer.triggerChange(signal,oldValue,newValue);
	}
	
	/**
	 * Triggers the specified signal to be recorded on currently recording observers.
	 * @param {signalInstance} signal - The signal to record
	 * @throws {TypeError} If signal is not a signalInstance instance
	 */
	triggerRecording(signal){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerRecording signal must be a signalInstance");
		if(!this.#preventObservers) for(let observer of this.#observersRecording) if(!observer.hasSignal(signal)) observer.recordSignal(signal);
	}
	
	/**
	 * This method wraps a function in a context where signal recording is disabled for existing observers.
	 * This is useful for nested operations like computed signals. Nested observers can still record.
	 * @param {Function} fn - Function to run in isolated recording context
	 * @returns {Function} A wrapped function that executes in isolated recording mode
	 * @throws {TypeError} If fn is not a Function
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
	 * Prevents signals from triggering updates to observers during function execution.
	 * @param {Function} fn - Function to run without triggering observer updates
	 * @param {...*} args - Arguments to pass to the function
	 * @returns {*} The function's result, or throws any error that occurred
	 * @throws {TypeError} If fn is not a Function
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
	 * Prevents observers from recording signals during function execution.
	 * @param {Function} fn - Function to run without observers recording signals
	 * @param {...*} args - Arguments to pass to the function
	 * @returns {*} The function's result, or throws any error that occurred
	 * @throws {TypeError} If fn is not a Function
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
	 * Creates a new signalInstance and records it to any recording observers.
	 * @param {any} value - Initial signal value (cannot be Array, Map, or Set)
	 * @param {boolean} [useWeakRef=false] - Use WeakRef for the value. It must be referenced elsewhere otherwise it may vanish on a GC event
	 * @returns {signalInstance} The created signal instance
	 * @throws {TypeError} If value is an Array, Map, or Set (use proxySignal instead)
	 */
	createSignal(value=void 0,useWeakRef=false){
		if(value instanceof Array) throw new TypeError("createSignal value is an Array, use proxySignal instead");
		if(value instanceof Map) throw new TypeError("createSignal value is a Map, use proxySignal instead");
		if(value instanceof Set) throw new TypeError("createSignal value is a Set, use proxySignal instead");
		let signal = new signalInstance(this,value,useWeakRef); signal.record();
		return signal;
	}
	
	/**
	 * Creates a signalInstance and defines a getter/setter on the target object.
	 * @param {object} obj - Target object to define the property on
	 * @param {string} prop - Property name to define
	 * @param {any} [value=void 0] - Initial signal value or existing signal instance
	 * @param {PropertyDescriptor|object} [descriptor={}] - Property descriptor options
	 * @param {boolean} [useOriginal=true] - Use existing getter/setter
	 * @returns {signalInstance} The created or provided signal instance
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
	 * Defines signals for each property from a source object and assigns them to target.
	 * @param {object} target - Target object to assign signals to
	 * @param {object} source - Source object to copy properties from
	 * @returns {object} The target object with signals assigned
	 */
	assignSignals(target,source){
		for(let [key,val] of Object.entries(source)) this.defineSignal(target,key,val,getOwnPropertyDescriptor(source,key));
		return target;
	}
	
	/**
	 * Creates a PUSH-based computed signal.
	 * 
	 * PUSH-based computed signals compute their value whenever any of their dependency signals change.
	 * @param {Function} fn - Callback function that computes the signal value
	 * @param {object} [options={}] - Compute options
	 * @param {boolean} [options.defer=false] - Defer computation
	 * @param {signalInstance} [options.signal] - Pre-existing signal to use
	 * @returns {Array<[signalInstance, signalObserver, Function]>} Tuple of [signal, observer, clear function]
	 * @throws {TypeError} If fn is not a function
	 */
	computeSignalPush(fn,options={}){
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
		let result = [ signal, obs, obs.clear.bind(obs) ];
		if(Symbol.dispose) result[Symbol.dispose] = result[2];
		return result;
	}
	
	/**
	 * Creates a PULL-based computed signal.
	 *
	 * PULL-based computed signals only compute their value when read.
	 * @param {Function} fn - Callback function that computes the signal value
	 * @param {object} [options={}] - Compute options
	 * @param {boolean} [options.defer=false] - Defer computation
	 * @param {signalInstance} [options.signal] - Pre-existing signal to use
	 * @returns {Array<[signalInstance, signalObserver, Function]>} Tuple of [signal, observer, clear function]
	 * @throws {TypeError} If fn is not a function
	 */
	computeSignalPull(fn,options={}){
		if(!(fn instanceof Function)) throw new TypeError("computeSignalPull fn must be a Function (callback)");
		let signal = options?.signal || this.createSignal(void 0);
		let obs = this.createObserver(options);
		obs.signalsIgnore.add(signal);
		let isUpdating = false;
		let updateFn = function signalUpdate(){
			if(isUpdating) return;
			isUpdating = true;
			signal.invalidatePull();
			signal.changed(true);
			isUpdating = false;
		};
		let recordingFn = this.isolateRecording(obs.wrapRecorder(fn));
		signal.addPullListener(function signalComputePullFn(){
			obs.clearSignals();
			signal.set(recordingFn());
		});
		obs.addListener(updateFn);
		signal.invalidatePull();
		let result = [ signal, obs, obs.clear.bind(obs) ];
		if(Symbol.dispose) result[Symbol.dispose] = result[2];
		return result;
	}
	
	/**
	 * Alias that creates a computed signal (PUSH or PULL based).
	 * @param {Function} fn - Compute callback function
	 * @param {object} [options={}] - Computed signal options
	 * @param {boolean} [options.pull=true] - Use PULL-based computation
	 * @returns {Array<[signalInstance, signalObserver, Function]>} Tuple of [signal, observer, clear function]
	 * @throws {TypeError} If fn is not a function
	 */
	computeSignal(fn,options={}){
		options = { __proto__:null, pull:true, ...options };
		if(options.pull) return this.computeSignalPull(fn,options);
		else return this.computeSignalPush(fn,options);
	}
	
	/**
	 * Creates a deep reactive proxy for objects with automatic signal tracking.
	 *
	 * A signalProxy creates a proxy that automatically creates signalInstance and
	 * signalProxy for every property accessed, enabling infinitely deep reactivity.
	 * Each nested property becomes a signal that can be tracked and updated independently.
	 * The proxy supports arrays, Maps, Sets, and other iterable collections with special
	 * handling for their methods.
	 * @param {object} value - Object to proxy (must be an object, not a primitive)
	 * @param {signalInstance} [signal=null] - Pre-existing signal for the target
	 * @param {boolean} [useWeakRef=false] - Use WeakRef (defaults to true for nested proxies)
	 * @returns {signalProxy} Proxy of the passed in value
	 * @throws {TypeError} If value is a primitive
	 */
	proxySignal(value,signal=null,useWeakRef=false){
		if(value!==Object(value)) throw new TypeError("proxySignal target must not be a primitive");
		return new signalProxy(value,this,signal,useWeakRef);
	}
	
	/**
	 * Creates a signalProxy and defines a getter/setter on the target object.
	 * @param {object} obj - Target object to define the property on
	 * @param {string} prop - Property name to define
	 * @param {object} value - Object value to proxy (must be an object, not a primitive)
	 * @param {signalInstance} [signal=null] - Pre-existing signal for the value
	 * @returns {signalProxy} Proxy of the passed in value
	 * @throws {TypeError} If value is a primitive (use defineSignal instead)
	 */
	defineProxySignal(obj,prop,value,signal=null){
		if(value!==Object(value)) throw new TypeError("defineProxySignal target must not be a primitive, try defineSignal instead");
		if(!signal) signal = new signalInstance(this,value);
		let proxy = new signalProxy(value,this,signal);
		let sGet = ()=>(signal.record(),proxy), sSet = (v)=>{ this.defineProxySignal(obj,prop,v,signal); };
		sGet[signalSymb] = sSet[signalSymb] = signal;
		defineProperty(obj,prop,{ __proto__:null, configurable:true, enumerable:true, get:sGet, set:sSet });
		return signal.record(), signal.set(proxy), proxy;
	}
	
}
