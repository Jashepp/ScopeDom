
import {
	timing,
} from "./timing.js";

/**
 * Utility functions and prototypes for ScopeDom - lightweight, shared helpers for DOM
 * operations, object manipulation, event listening, and type checking.
 * 
 * Provides the fundamental building blocks other core modules depend on:
 * - Microtask deferral (resolvedPromise, originalDefer, noopFn)
 * - Object API access (getPrototypeOf, setPrototypeOf, defineProperty, etc.)
 * - DOM node + native prototype constants (for fast type-checking)
 * - Event registry (eventRegistry): a three-level Map of listeners
 * - Regex helpers, Set + WeakRef utilities
 * - Attribute setting (setAttribute) with a fallback for invalid names
 */

const hasQueueMicrotask = typeof queueMicrotask==='function';
/** Cached resolved Promise, reused to avoid repeated allocations. */
export const resolvedPromise = Promise.resolve();
/** Microtask deferral shim: `queueMicrotask` when available, else `.then` on a resolved Promise. */
export const originalDefer = hasQueueMicrotask ? queueMicrotask : Promise.prototype.then.bind(resolvedPromise);

/** A function that does nothing (returns undefined). */
export function noopFn(){};
/** An async function that does nothing (resolves without a value). */
export async function noopAsyncFn(){};

export const { getPrototypeOf, setPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn } = Object;

/** Union of two sets (native `Set.prototype.union` when available). */
export function setUnion(setA,setB){ return Set.prototype.union ? setA.union(setB) : new Set([...setA,...setB]); };
/** Fallback support for Symbol.dispose */
export const disposeSymbol = Symbol.dispose || Symbol.for('Symbol.dispose');

/** Checks if the value is a Promise or thenable. */
export function isPromise(value){ return value instanceof Promise || ('then' in Object(value) && typeof value?.then==="function"); };

// regexUtils
export function regexMatchAll(str,r){ return str.matchAll(r); } // matchAll clones regex, and doesn't need lastIndex=0
export function regexExec(str,r){ r.lastIndex=0; return r.exec(str); };
export function regexTest(str,r){ r.lastIndex=0; return r.test(str); };
export function regexMatchAllFirstGroup(str,regex){
	let match, matches=[]; regex.lastIndex=0;
	while(match=regex.exec(str)) matches.push(match[1]);
	return matches;
}


export const elementNodeType = document.ELEMENT_NODE;
export const commentNodeType = document.COMMENT_NODE;
export const textNodeType = document.TEXT_NODE;

export const objectProto = getPrototypeOf(Object()); // window.Object===objectProto.constructor
export const nodeProto = getPrototypeOf(getPrototypeOf(getPrototypeOf(document.createTextNode('text'))));
export const elementProto = getPrototypeOf(getPrototypeOf(getPrototypeOf(document.createElement('div'))));
export const functionProto = getPrototypeOf(noopFn);
export const functionAsyncProto = getPrototypeOf(noopAsyncFn);
export const nativeProtos = [objectProto,nodeProto,elementProto,functionProto,functionAsyncProto];
export const nativeConstructors = nativeProtos.map(p=>p?.constructor);
/** Checks if the value is one of the known native objects or prototypes. */
export function isNative(obj){ return nativeProtos.indexOf(obj)!==-1 || nativeConstructors.indexOf(obj)!==-1; }
/** Checks if an object is non-native (eg, a user-provided value). */
export function scopeAllowed(obj){ return obj && !isNative(obj); }


/** Proxies a property on `target` via a WeakRef; returns the target. */
export const defineWeakRef = (target,prop,value=target[prop])=>{
	if(!window.WeakRef) return target[prop]=value, target;
	let ref = new WeakRef(value);
	defineProperty(target,prop,{ __proto__:null, get(){ return ref.deref(); }, set(v){ ref=new WeakRef(v); } });
	return target;
};

const setAttributeElement = document.createElement('template');
/** Sets an attribute, falling back to parsed HTML for names browsers would reject. */
export function setAttribute(target,name,value){
	try{ target.setAttribute(name,value); }
	catch(e){
		let t=setAttributeElement; t.innerHTML=`<span ${name}=""></span>`;
		let a=t.content.firstChild.attributes.item(name).cloneNode(false); a.value=value;
		target.attributes.setNamedItem(a);
	}
}


/**
 * Event Registry - three-level Map structure for tracking event listeners.
 * 
 * Maintains a `Map<Target, Map<eventName, Map<listener, Set<options>>>>` structure
 * with a parallel native `addEventListener`/`removeEventListener` registry.
 * Allows granular listener removal by target, name, listener, and options combination.
 * 
 * @class eventRegistry
 */
export class eventRegistry {
	
	constructor(){
		this.map = new Map();
	}

	/**
	 * Add a listener to the event registry.
	 * 
	 * @param {EventTarget} target Target to add the listener to
	 * @param {string} name Event name
	 * @param {Function} listener Listener function
	 * @param {object} [options={}] Event listener options
	 */
	add(target,name,listener,options={}){
		let targetMap = this.map;
		if(!targetMap.has(target)) targetMap.set(target,new Map());
		let nameMap = targetMap.get(target);
		if(!nameMap.has(name)) nameMap.set(name,new Map());
		let listenerMap = nameMap.get(name);
		if(!listenerMap.has(listener)) listenerMap.set(listener,new Set());
		let optionsSet = listenerMap.get(listener);
		optionsSet.add(options);
		target.addEventListener(name,listener,options);
	}

	/**
	 * Remove a listener from the event registry.
	 * 
	 * If all arguments are provided, removes exactly that combination.
	 * If name is null, removes all listeners on target.
	 * If listener is null, removes all listeners for that name on target.
	 * 
	 * @param {EventTarget} target Target to remove from
	 * @param {string|null} [name=null] Event name to match; null for all
	 * @param {Function|null} [listener=null] Listener to match; null for all with name
	 * @param {object|null} [options=null] Options to match; null for all with same listener
	 */
	remove(target,name=null,listener=null,options=null){
		if(!this.map.has(target)) return;
		let nameMap = this.map.get(target);
		if(name===null){
			for(const [keyN,listenerMap] of nameMap) for(const [keyL,optionsSet] of listenerMap) for(const opts of optionsSet) target.removeEventListener(keyN,keyL,opts);
		}
		else if(nameMap.has(name)){
			let listenerMap = nameMap.get(name);
			if(listener===null){
				for(const [keyL,optionsSet] of listenerMap) for(const opts of optionsSet) target.removeEventListener(name,keyL,opts);
			}
			else if(listenerMap && listenerMap.has(listener)){
				let optionsSet = listenerMap.get(listener);
				if(options===null){
					for(const opts of optionsSet) target.removeEventListener(name,listener,opts);
				}
				else if(optionsSet.has(options)){
					target.removeEventListener(name,listener,options);
					optionsSet.delete(options);
				}
				if(optionsSet.size===0) listenerMap.delete(listener);
			}
			if(listenerMap && listenerMap.size===0) nameMap.delete(name);
		}
		if(nameMap.size===0) this.map.delete(target);
	}

}


let mtCacheWM = new WeakMap(), mtDeferring = false, mtDeferAgain = false;

/**
 * Microtask Cache - WeakMap-bounded memoization cache.
 * 
 * Stores computed values keyed by WeakMap reference + string key. Values are deferred
 * cleaned up via a microtask.
 * 
 * Used by `mtCacheDefineProperty`, `mtCacheSetPrototypeOf`, and related helpers to cache
 * property descriptors, prototypes, and other expensive per-property lookups.
 * 
 * @class microtaskCache
 */
export class microtaskCache {
	
	/**
	 * Get a cached value, or return undefined if not present.
	 * Sets `mtDeferAgain` flag if currently deferring cleanup to coalesce cleanup.
	 * 
	 * @param {object} wmKey WeakMap key (usually the target object)
	 * @param {string} key Cache key within the inner Map
	 * @returns {any} Cached value, or undefined if not cached
	 */
	static get(wmKey,key){
		if(mtDeferring) mtDeferAgain = true;
		return mtCacheWM.get(wmKey)?.get(key);
	}
	
	/**
	 * Get a cached value, or compute+cache it if not present.
	 * Schedules deferred cleanup on first miss. Subsequent misses coalesce via `mtDeferAgain`.
	 * 
	 * @param {object} wmKey WeakMap key
	 * @param {string} key Cache key
	 * @param {Function} fn Function to compute the value
	 * @returns {any} Cached or computed value
	 */
	static getOrCompute(wmKey,key,fn){
		let innerMap, hasMap = mtCacheWM.has(wmKey);
		if(!hasMap) mtCacheWM.set(wmKey,innerMap=new Map());
		else innerMap = mtCacheWM.get(wmKey);
		if(mtDeferring) mtDeferAgain = true;
		if(hasMap && innerMap.has(key)) return innerMap.get(key);
		let value = fn();
		innerMap.set(key,value);
		if(!mtDeferring){
			mtDeferring = true;
			originalDefer(microtaskCache.#deferredCleanup);
		}
		else mtDeferAgain = true;
		return value;
	}
	
	/**
	 * Set a cached value, scheduling deferred cleanup if first miss.
	 * 
	 * @param {object} wmKey WeakMap key
	 * @param {string} key Cache key
	 * @param {any} value Value to cache
	 * @returns {any} The cached value
	 */
	static set(wmKey,key,value){
		let innerMap, hasMap = mtCacheWM.has(wmKey);
		if(!hasMap) mtCacheWM.set(wmKey,innerMap=new Map());
		else innerMap = mtCacheWM.get(wmKey);
		innerMap.set(key,value);
		if(!mtDeferring){
			mtDeferring = true;
			originalDefer(microtaskCache.#deferredCleanup);
		}
		else mtDeferAgain = true;
		return value;
	}
	
	/**
	 * Remove a single key from the cache without triggering cleanup.
	 * 
	 * @param {object} wmKey WeakMap key
	 * @param {string} key Cache key to delete
	 * @returns {void}
	 */
	static delete(wmKey,key){
		mtCacheWM.get(wmKey)?.delete(key);
	}
	
	/**
	 * Run deferred cleanup: drains the entire cache when no further deferrals are pending.
	 * 
	 * If `mtDeferAgain` is true, re-schedules itself immediately to handle additional coalesced writes.
	 * Only when both `mtDeferring` and `mtDeferAgain` are false does it reset the WeakMap.
	 * 
	 * @private
	 */
	static #deferredCleanup(){
		if(!mtDeferring) return;
		if(mtDeferAgain){
			mtDeferAgain = false;
			originalDefer(microtaskCache.#deferredCleanup);
			return;
		}
		mtDeferring = false;
		mtDeferAgain = false;
		mtCacheWM = new WeakMap();
	}
	
}

/**
 * Microtask-Cached `Object.getOwnPropertyDescriptor` lookup.
 * Drops the stale cache entry when the property is rewritten.
 * 
 * @returns {object|undefined} the property descriptor, or `undefined`
 */
export function mtCacheGetDefinedProperty(obj,prop){
	let key = prop?.toString ? 'mtCachePropDesc:'+prop.toString() : prop;
	return microtaskCache.getOrCompute(obj,key,getOwnPropertyDescriptor.bind(null,obj,prop));
}

/**
 * Define the property, then drop the microtask-cached descriptor.
 * 
 * @returns the result of `Object.defineProperty`
 */
export function mtCacheDefineProperty(obj,prop,options){
	let result = defineProperty(obj,prop,options);
	let key = prop?.toString ? 'mtCachePropDesc:'+prop.toString() : prop;
	microtaskCache.delete(obj,key);
	return result;
}

/**
 * Microtask-Cached `Object.getPrototypeOf` lookup.
 * 
 * @returns {Object|null} the object's prototype, or `null`
 */
export function mtCacheGetPrototypeOf(obj){
	return microtaskCache.getOrCompute(obj,'mtCacheGetProto',getPrototypeOf.bind(null,obj));
}

/**
 * Set the object's prototype, then drop the microtask-cached lookup.
 * 
 * @returns {boolean} the result of `Object.setPrototypeOf`
 */
export function mtCacheSetPrototypeOf(obj,newProto){
	let result = setPrototypeOf(obj,newProto);
	microtaskCache.delete(obj,'mtCacheGetProto');
	return result;
}
