
import {
	timing,
} from "./timing.js";

const hasQueueMicrotask = typeof queueMicrotask==='function';
export const resolvedPromise = Promise.resolve();
export const originalDefer = hasQueueMicrotask ? queueMicrotask : Promise.prototype.then.bind(resolvedPromise);

export function noopFn(){};
export async function noopAsyncFn(){};

export const { getPrototypeOf, setPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn } = Object;

export function setUnion(setA,setB){ return Set.prototype.union ? setA.union(setB) : new Set([...setA,...setB]); };
export const disposeSymbol = Symbol.dispose || Symbol.for('Symbol.dispose');

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
export function isNative(obj){ return nativeProtos.indexOf(obj)!==-1 || nativeConstructors.indexOf(obj)!==-1; }
export function scopeAllowed(obj){ return obj && !isNative(obj); }


export const defineWeakRef = (target,prop,value=target[prop])=>{
	if(!window.WeakRef) return target[prop]=value, target;
	let ref = new WeakRef(value);
	defineProperty(target,prop,{ get(){ return ref.deref(); }, set(v){ ref=new WeakRef(v); } });
	return target;
};

const setAttributeElement = document.createElement('template');
export function setAttribute(target,name,value){ // Set attribute with less name limitations
	try{ target.setAttribute(name,value); }
	catch(e){
		let t=setAttributeElement; t.innerHTML=`<span ${name}=""></span>`;
		let a=t.content.firstChild.attributes.item(name).cloneNode(false); a.value=value;
		target.attributes.setNamedItem(a);
	}
}


export class eventRegistry {
	constructor(){
		this.map = new Map();
	}
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
export class microtaskCache {
	
	static get(wmKey,key){
		if(mtDeferring) mtDeferAgain = true;
		return mtCacheWM.get(wmKey)?.get(key);
	}
	
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
	
	static delete(wmKey,key){
		mtCacheWM.get(wmKey)?.delete(key);
	}
	
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

/** @type {typeof Object.getOwnPropertyDescriptor} */
export function mtCacheGetDefinedProperty(obj,prop){
	let key = prop?.toString ? 'mtCachePropDesc:'+prop.toString() : prop;
	return microtaskCache.getOrCompute(obj,key,_=>getOwnPropertyDescriptor(obj,prop));
}

/** @type {typeof Object.defineProperty} */
export function mtCacheDefineProperty(obj,prop,options){
	let result = defineProperty(obj,prop,options);
	let key = prop?.toString ? 'mtCachePropDesc:'+prop.toString() : prop;
	microtaskCache.delete(obj,key);
	return result;
}

/** @type {typeof Object.getPrototypeOf} */
export function mtCacheGetPrototypeOf(obj){
	return microtaskCache.getOrCompute(obj,'mtCacheGetProto',_=>getPrototypeOf(obj));
}

/** @type {typeof Object.setPrototypeOf} */
export function mtCacheSetPrototypeOf(obj,newProto){
	let result = setPrototypeOf(obj,newProto);
	microtaskCache.delete(obj,'mtCacheGetProto');
	return result;
}
