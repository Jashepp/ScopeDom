
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
import { signalInstance, signalSymb } from "./instance.js";
import { signalProxy, resolveSignal } from "./proxy.js";

/**
 * SignalObserver - Tracks signal dependencies and reacts to changes.
 *
 * A signalObserver monitors a set of signals and executes registered listeners when any of those signals change.
 * @class signalObserver
 * @prop {signalController} ctrl - The parent signal controller
 * @prop {WeakSet<signalInstance>} signals - WeakSet of signals this observer depends on
 * @prop {WeakSet<signalInstance>} signalsIgnore - WeakSet of signals to ignore during recording
 * @prop {Set<Function>} listeners - Set of listener callbacks
 * @prop {boolean} deferChange - Defer change notifications
 * @prop {boolean} isDeferring - Change notification is pending
 */
export class signalObserver {
	
	/**
	 * Constructs a new signalObserver, with a reference to the parent signal controller.
	 * @param {signalController} signalCtrl - The parent signal controller
	 * @param {object} [options={}] - Observer options
	 * @param {boolean} [options.defer=true] - Defer listener execution
	 */
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
	
	/**
	 * Checks if the observer depends on a specific signal.
	 * @param {signalInstance} signal - The signal to check
	 * @returns {boolean} True if the observer depends on the signal
	 */
	hasSignal(signal){ return this.signals.has(signal); }
	
	/**
	 * Records a signal as a dependency of this observer.
	 * @param {signalInstance} signal - The signal to record
	 */
	recordSignal(signal){
		if(!this.signals.has(signal) && !this.signalsIgnore.has(signal)) this.signals.add(signal);
	}
	
	/**
	 * Triggers change notifications to all registered listeners.
	 * 
	 * The listeners are invoked with the arguments: signalObserver, signalInstance, old value, new value.
	 * @param {signalInstance} signal - The signal that changed
	 * @param {any} oldValue - The previous value before the change
	 * @param {any} newValue - The new value after the change
	 * @param {boolean} [forceDefer=false] - Force defer listeners
	 */
	triggerChange(signal,oldValue,newValue,forceDefer=false){
		if(this.isDeferring || this.isRecording) return;
		if(this.isChanging || !this.signals.has(signal)) forceDefer = true;
		let self=this;
		function signalObserverListener(fn){ fn(self,signal,oldValue,newValue); }
		function signalObserverTrigger(){
			self.isDeferring = false;
			if(self.isChanging || self.listeners.size===0) return;
			self.isChanging = true;
			for(let fn of self.listeners) try{ signalObserverListener(fn); } catch(err){ console.error(err); }
			self.isChanging = false;
		}
		if(!this.deferChange && !forceDefer) return signalObserverTrigger();
		this.isDeferring = true;
		deferFn(signalObserverTrigger);
	}
	
	/**
	 * Starts recording signals for this observer.
	 * 
	 * Signal changes will not be triggered during a recording.
	 * @returns {boolean} True if recording was started, false if already recording
	 */
	startRecording(){
		if(this.isRecording) return false;
		this.isRecording = true;
		this.ctrl.startObserverRecording(this);
		return true;
	}
	
	/**
	 * Stops recording signals for this observer.
	 * @returns {boolean} True if recording was stopped, false if not recording
	 */
	stopRecording(){
		if(!this.isRecording) return false;
		this.isRecording = false;
		this.ctrl.stopObserverRecording(this);
		return true;
	}
	
	/**
	 * Wraps a function to only execute within recording mode.
	 * @param {Function} fn - Function to wrap
	 * @returns {Function} Wrapped function that does recording
	 */
	wrapRecorder(fn){
		let self = this;
		return function signalObserverRecorder(...args){
			let recording = self.startRecording();
			let result; try{ result=fn(...args); }catch(err){ console.error(err); }
			if(recording) self.stopRecording();
			return result;
		};
	}
	
	/**
	 * Adds a listener callback to the observer.
	 * @param {Function} fn - Listener callback function
	 * @returns {Function} A function to remove the listener
	 */
	addListener(fn){ this.listeners.add(fn); return this.removeListener.bind(this,fn); }
	
	/**
	 * Removes a listener callback from the observer.
	 * @param {Function} fn - Listener callback function to remove
	 */
	removeListener(fn){ this.listeners.delete(fn); }
	
	/**
	 * Clears all listeners and signals, and removes the observer from the controller.
	 */
	clear(){ this.listeners.clear(); this.signals=new WeakSet(); this.ctrl.removeObserver(this,false); }
	
	/**
	 * Only clears signals. Observer remains active in the controller.
	 */
	clearSignals(){ this.signals=new WeakSet(); }
}

if(Symbol.dispose) signalObserver.prototype[Symbol.dispose] = signalObserver.prototype.clear;
