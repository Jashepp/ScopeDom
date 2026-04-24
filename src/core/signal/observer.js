
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
 * Signal Observer for tracking signal dependencies.
 * 
 * The signal observer is the dependancy tracker of the reactive signal system.
 * 
 * This class implements:
 * - Recording mode to capture signal dependencies as they're accessed
 * - Change notifications for when a signal is updated
 * - WeakRef support for object values (memory-safe references)
 * 
 * @class signalObserver
 * @property {signalController} ctrl - The parent signal controller that manages this observer's lifecycle
 * @property {WeakSet<signalInstance>} signals - WeakSet of signals this observer depends on
 * @property {WeakSet<signalInstance>} signalsIgnore - WeakSet of signals to ignore during recording (e.g., the signal being computed)
 * @property {Set<Function>} listeners - Set of listener callbacks invoked when dependent signals change; each called with (observer, signal, oldValue, newValue)
 * @property {boolean} deferChange - Defer change notifications for batching purposes
 * @property {boolean} isDeferring - Change notification has been deferred and not yet executed
 * 
 * @see {@link signalController} - Signal Controller for managing signals and observers
 * @see {@link signalInstance} - Signal Instance that represents a reactive signal value
 * @see {@link signalProxy} - Signal Proxy for deep reactivity for objects with automatic signal tracking
 */
export class signalObserver {
	
	/**
	 * Constructs a new signalObserver, with a reference to the parent signal controller.
	 * 
	 * @param {signalController} signalCtrl - The parent signal controller that manages this observer
	 * @param {object} [options={}] - Observer options
	 * @param {boolean} [options.defer] - Defer listener execution for batching; defaults to ScopeDom instance options.signalDefer
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
	 * 
	 * @param {signalInstance} signal - The signal to check
	 * @returns {boolean} True if the observer depends on the signal
	 */
	hasSignal(signal){ return this.signals.has(signal); }
	
	/**
	 * Records a signal as a dependency of this observer.
	 * 
	 * Only records if the signal is not already in `signals` and not in `signalsIgnore`.
	 * This prevents duplicate entries and respects ignored signals during recording mode.
	 * 
	 * @param {signalInstance} signal - The signal to record as a dependency
	 */
	recordSignal(signal){
		if(!this.signals.has(signal) && !this.signalsIgnore.has(signal)) this.signals.add(signal);
	}
	
	/**
	 * Triggers change notifications to all registered listeners.
	 * 
	 * Listeners are invoked with the arguments: signalObserver, signalInstance, old value, new value.
	 * 
	 * This method implements deferred execution (if enabled) for batching multiple changes together.
	 * 
	 * State flags used:
	 * - `isDeferring`: If true, a deferred notification is pending; if false, notifications are immediate
	 * - `isRecording`: If true, we're in recording mode and should not trigger changes
	 * - `isChanging`: If true, listeners are currently executing; prevents re-entry
	 * 
	 * @param {signalInstance} signal - The signal that changed
	 * @param {any} oldValue - The previous value before the change
	 * @param {any} newValue - The new value after the change
	 * @param {boolean} [forceDefer=false] - Force deferral of listeners (bypasses normal immediate execution)
	 */
	triggerChange(signal,oldValue,newValue,forceDefer=false){
		if(this.isDeferring || this.isRecording) return;
		if(this.isChanging || !this.signals.has(signal)) forceDefer = true;
		let self=this;
		// Executes a listener
		function signalObserverListener(fn){ fn(self,signal,oldValue,newValue); }
		// Perform change notification
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
	 * When an observer is in "recording mode", it captures signal dependencies as they're accessed.
	 * Signal changes will not be triggered during a recording - only dependency tracking occurs.
	 * 
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
	 * 
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
	 * 
	 * The returned wrapper starts recording before executing the wrapped function,
	 * then stops recording after execution completes. This ensures that any signals
	 * accessed during the function's execution are properly captured as dependencies.
	 * 
	 * @param {Function} fn - Function to wrap in recording mode
	 * @returns {Function} Wrapped function that starts/stops recording around execution
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
	 * 
	 * Returns a cleanup function that can be called to remove this specific listener.
	 * 
	 * @param {Function} fn - Listener callback function (invoked as fn(observer, signal, oldValue, newValue))
	 * @returns {Function} A cleanup function that removes the listener when called
	 */
	addListener(fn){ this.listeners.add(fn); return this.removeListener.bind(this,fn); }
	
	/**
	 * Removes a listener callback from the observer.
	 * 
	 * @param {Function} fn - Listener callback function to remove
	 */
	removeListener(fn){ this.listeners.delete(fn); }
	
	/**
	 * Clears all listeners and signals, and removes the observer from the controller.
	 * This fully disposes of the observer's resources.
	 */
	clear(){ this.listeners.clear(); this.signals=new WeakSet(); this.ctrl.removeObserver(this,false); }
	
	/**
	 * Only clears signals. Observer remains active in the controller.
	 * Use this when you want to reset dependencies without fully disposing the observer.
	 * 
	 * Used internally by computed signals.
	 */
	clearSignals(){ this.signals=new WeakSet(); }
}

if(Symbol.dispose) signalObserver.prototype[Symbol.dispose] = signalObserver.prototype.clear;
