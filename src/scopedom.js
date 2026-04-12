
import {
	noopFn, noopAsyncFn, deferFn,
	animFrameHelper, regexMatchAll, regexExec, regexTest, regexMatchAllFirstGroup,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	isElementLoaded, setAttribute, eventRegistry,
} from "./core/utils.js";
import {
	execExpression, execExpressionProxy,
} from "./core/exec.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal,
} from "./core/signal.js";
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "./core/scope.js";

const disableDocumentDefaultView = ()=>{
	try{ defineProperty(window.document,'defaultView',{
		get(){ return console.warn("ScopeDom: document.defaultView is disabled"), { __proto__:null, getComputedStyle:window.getComputedStyle.bind(window) }; }
	}); }
	catch(e){ console.warn("ScopeDom: Failed to disable document.defaultView\n",e); }
}

/** @template {object} ScopeDomInitOptions */
const initOptionsDefaults = {
	dev: true, // Verbose developer logging
	attribRegexMatch: /^\$((?:[\.\w\d]+)(?:\-[\.\w\d]+)*?)(?:\:((?:[\.\w\d]+)(?:\-[\.\w\d]+)*?))?$/, // group1: name, group2: option
	attribRegexParts: /([\.\w\d]+)/g,
	attribIgnore: '$ignore',
	globalContext: true,
	documentContext: true,
	documentDefaultView: false,
	/** @type {scopeBase|object|null} */
	scope: null,
	attributeAliases: null,
	attributeAliasNameKeys: null,
	autoReady: true,
	/** @type {HTMLElement|null} */
	element: null,
	onlyInstance: true, // Prevent further instances
	privateInstance: false, // Enforces use of direct instance reference & prevent late plugins
	allowLatePlugins: true, // Prevent pluginAdd after ScopeDom init (defaults to false on privateInstance)
	signalDefer: true,
	signalProxyAll: true,
};
let initOptionsScriptTag = null;

/** @template {object} scopeElementAttrib */
const scopeElementAttribDefaults = {
	isDefault: true,
	/** @type {string|null} */
	attribute: null,
	/** @type {string|null} */
	nameKey: null,
	/** @type {string|null} */
	nameParts: null,
	/** @type {string|null} */
	value: null,
	/** @type {Map<string,scopeElementAttribOption>|null} */
	options: null,
};
/** @template {object} scopeElementAttribOption */
const scopeElementAttribOptionDefaults = {
	isDefault: false,
	/** @type {string|null} */
	attribute: null,
	/** @type {string|null} */
	nameKey: null,
	/** @type {Array<string>|null} */
	optionParts: null,
	/** @type {string|null} */
	value: null
};

/** @type {Set<ScopeDom>} */
const allInstances = new Set();

/** @type {ScopeDom|null} */
let mainInstance = null;

/** @type {ScopeDom|null} */
let onlyInstance = null;

/** @type {Set<object|Function>|null} */
let pluginsPostMain = null;

/**
 * @typedef ScopeDomCtrlCallbackObj
 * @prop {Proxy|object|any} scope
 * @prop {ScopeDom} instance
 * @prop {scopeController} controller
 * @prop {typeof scopeController.prototype.$signal} signal
 * @prop {typeof signalController.prototype.createSignal} createSignal
 * @prop {typeof signalController.prototype.defineSignal} defineSignal
 * @prop {typeof signalController.prototype.assignSignals} assignSignals
 * @prop {typeof signalController.prototype.computeSignal} computeSignal
 * @prop {typeof signalController.prototype.proxySignal} proxySignal
 * @prop {typeof signalController.prototype.defineProxySignal} defineProxySignal
 */

/**
 * @callback ScopeDomCtrlCallback
 * @param {ScopeDomCtrlCallbackObj} detailsObject
 * @returns {void}
 */

/** @class ScopeDom */
class ScopeDom {
	
	static setupScriptTag(){
		ScopeDom.setupScriptTag = noopFn;
		// Check attributes on current script
		for(let script=document?.currentScript;script;script=0){
			// Options data-scopedom-options='{"globalContext":false}'
			try{
				let json, str = script?.getAttribute('data-scopedom-options') || null;
				if(str && typeof str==='string') json = JSON.parse(str);
				if(json && typeof json==='object' && Object.keys(json).length>0){
					initOptionsScriptTag = { __proto__:null, ...json };
					if(initOptionsScriptTag.dev) console.log("scopeDOM: loaded options from script tag");
				}
			} catch(err){ console.error("scopeDOM: failed to load options from script tag",err,script); }
			// Init data-scopedom-init
			if(script?.getAttribute('data-scopedom-init')===''){
				try{
					if(mainInstance){
						console.log("ScopeDom: main instance is already initialised");
						return;
					}
					if(initOptionsScriptTag && 'privateInstance' in initOptionsScriptTag && initOptionsScriptTag.privateInstance){
						console.log("scopeDOM: init via script tag cannot be used with option { privateInstance:true }");
						return;
					}
					let instance = ScopeDom.init();
					if(instance.options.dev) console.log("scopeDOM: init from script tag");
				} catch(err){ console.error("scopeDOM: failed to init from script tag",err,script); }
			}
		}
	}
	
	/**
	 * @static
	 * @param {ScopeDomInitOptions|object|null} initOptions
	 * @returns {ScopeDom}
	 * @throws {Error}
	 */
	static init(initOptions={}){
		if(mainInstance) throw new Error("ScopeDom: main instance is already initialised");
		let instance = new ScopeDom(initOptions);
		return instance.beginDomWatching(), instance;
	}
	
	/**
	 * @static
	 * @returns {ScopeDom}
	 * @throws {Error}
	 */
	static getInstance(){
		if(!mainInstance) throw new Error("ScopeDom: no main instance, use ScopeDom.init");
		if(mainInstance.options.privateInstance) throw new Error("ScopeDom: main instance is private, directly reference that instance instead");
		return mainInstance;
	}
	
	/**
	 * Define scope controller on main ScopeDom instance
	 * @static
	 * @param {Function|string|null=} name Scope Controller Name
	 * @param {ScopeDomCtrlCallback=} fn Scope Controller Function
	 * @returns {ScopeDom} ScopeDom instance
	 */
	static controller(name,fn){
		return ScopeDom.getInstance().controller(name,fn);
	}
	
	/**
	 * @param {object|Function} plugin
	 * @returns {boolean}
	 * @throws {Error}
	 */
	static pluginAdd(plugin){
		if(mainInstance && !mainInstance.options.allowLatePlugins) throw new Error("ScopeDom: late plugin adding is disabled, due to main instance { allowLatePlugins:false }");
		for(let inst of allInstances){
			if(inst.options.allowLatePlugins) inst.pluginAdd(plugin) || console.error("ScopeDom: failed to add plugin to an instance");
		}
		return true;
	}
	
	/**
	 * @constructor
	 * @param {ScopeDomInitOptions|object|null} initOptions
	 */
	constructor(initOptions={}){
		if(onlyInstance) throw new Error("ScopeDom: a private instance is already initialised");
		initOptions = { __proto__:null, ...initOptionsScriptTag, ...initOptions };
		let options = { __proto__:null, ...initOptionsDefaults, ...initOptions };
		if(!options.globalContext && options.documentContext && !options.documentDefaultView && window.document) disableDocumentDefaultView();
		else if(options.globalContext && !options.documentContext) throw new Error("ScopeDom: For documentContext to be false, globalContext must also be false");
		if(options.onlyInstance && mainInstance) throw new Error("ScopeDom: only the main (first) instance can use { onlyInstance:true }");
		if(options.onlyInstance) onlyInstance = this;
		if(!mainInstance) mainInstance = this;
		allInstances.add(this);
		let scope = options.scope===Object(options.scope) ? options.scope : new scopeBase();
		/** @type {ScopeDomInitOptions} */
		this.options = options;
		/** @type {HTMLElement|null} */
		this.mainElement = options.element || null;
		/** @type {scopeController} */
		this.scopeCtrl = new scopeController(scope,null,null,false,this);
		this.namedControllers = new Map();
		this.cacheWatchObservers = new Map();
		this.cacheConnectedNodes = new WeakSet();
		this.pendingConnectNodes = new Set();
		this.pendingOnElementLoaded = new Map();
		this.cacheElementScopeCtrls = new WeakMap();
		this.cacheElementAttribs = new WeakMap();
		this.cacheElementAttribsDefaults = new WeakMap();
		this.ignoreNodes = new WeakSet();
		this.elementRelatedEventListeners = new WeakMap();
		this.elementExtraScopes = new WeakMap(); // element -> array -> objects/elements
		this.elementIsolatedScopes = new WeakSet();
		this.onReadyListeners = new Set();
		this.onDOMReadyListeners = new Set();
		this.isDuringOnReady = false;
		// Plugins
		this.plugins = { init:false, register:new Set(), onConnect:new Set(), onDisconnect:new Set(), onPluginAdd:new Set(), onExpression:new Set() };
		try{ this.initPlugins(); }catch(err){ console.error("ScopeDom: error during initPlugins:",err); }
		if(mainInstance===this){
			pluginsPostMain = new Set();
			for(let p of Object.values(window.ScopeDomPlugins||[])) pluginsPostMain.add(p);
		}
		if(options.privateInstance && !('allowLatePlugins' in initOptions)) options.allowLatePlugins = false;
		Object.freeze(this.options);
	}
	
	/**
	 * Start a MutationObserver to observe for changes on the DOM
	 */
	beginDomWatching(){
		let mutObs=null, onMainElement=()=>{
			if(!this.mainElement) this.mainElement=document.body;
			if(mutObs) mutObs.disconnect();
			this.watchDomTree(this.mainElement);
			this.scanDomTree(this.mainElement);
			if(this.options.autoReady){
				this.setReadyOnDomLoaded();
				this.setReadyOnRaf();
			}
		};
		if(this.mainElement) onMainElement();
		else {
			if(document.body) return onMainElement();
			mutObs = new MutationObserver(function domMutation(m){ if(document.body) onMainElement(); });
			mutObs.observe(document.head.parentNode,{ __proto__:null, subtree:false, childList:true, attributes:false });
		}
	}
	
	// Scope Handling
	/**
	 * Define scope controller
	 * @param {Function|string|null=} name Scope Controller Name
	 * @param {ScopeDomCtrlCallback=} fn Scope Controller Function
	 * @returns {ScopeDom} ScopeDom instance
	 */
	controller(name,fn){
		if(typeof name==="function") return this.controller(null,name);
		if(name===null || name===false || name===void 0) name = null;
		if(fn===null || fn===false || fn===void 0) fn = null;
		if(name===null && fn===null){ // Disable/Empty default scopeController
			this.namedControllers.set(null,{ __proto__:null, element:null, name, fn });
			return;
		}
		if(!(typeof fn==="function")) throw new Error("ScopeDom: controller params must be (name,function) or (function)");
		if(name!==null) name = ''+name;
		if(this.namedControllers.has(name)) throw new Error(`ScopeDom: controller '${name===null?'default':`"${name}"`}' already exists, specify a different name`);
		let ctrl = { __proto__:null, element:null, name, fn };
		this.namedControllers.set(name,ctrl);
		// Default Controller
		if(name===null){
			let scope = this.scopeCtrl.scope, { globalContext, signalProxyAll } = this.options;
			let setScopes=new Set(); for(let s=scope; s && s!==Object; s=getPrototypeOf(s)) setScopes.add(s); 
			let proxy = new execExpressionProxy({ __proto__:null, mainScopes:[scope], getScopes:new Set([this.scopeCtrl.execContext,scope]), setScopes, silentHas:false, globalsHide:!globalContext, useSignalProxy:!!signalProxyAll });
			this.handleScopeCtrlFn(proxy,fn);
		}
		return this;
	}
	
	handleScopeCtrlFn(proxy,fn){
		let signal = this.scopeCtrl.$signal.bind(this.scopeCtrl); // signal(value) : [get,set,signal]
		let signalCtrl = this.scopeCtrl.signalCtrl, signalMethods = Object.fromEntries(
			['createSignal','defineSignal','assignSignals','computeSignal','proxySignal','defineProxySignal','preventUpdates','preventObservers']
			.map(k=>[k,signalCtrl[k].bind(signalCtrl)])
		);
		fn.apply(proxy,[{ scope:proxy, instance:this, controller:this.scopeCtrl, signal, ...signalMethods }]);
	}
	
	// Element Scanning & Watching
	scanDomTree(...args){ return this.connectElementAndChildren(...args); }
	watchDomTree(element){
		if(this.cacheWatchObservers.has(element)) return;
		let self=this, mutObs=new MutationObserver(function domWatching(muts){
			let check=false;
			for(let m of muts){
				if(m.addedNodes.size>0) check=true;
				for(let e of m.addedNodes) self.connectElementAndChildren(e,void 0,void 0,true);
				for(let e of m.removedNodes) self.disconnectElementAndChildren(e);
			}
			if(check) this.checkPendingConnectElements();
		});
		this.cacheWatchObservers.set(element,mutObs);
		mutObs.observe(element,{ subtree:true, childList:true, attributes:false });
	}
	setReadyOnDomLoaded(){
		if(document.readyState!=='loading') this.triggerOnReady(); // Do not delay this
		let listener = function onDOMReadyStateChange(){
			if(document.readyState==='interactive') this.triggerOnReady();
			else if(document.readyState==='complete'){
				document.removeEventListener("readystatechange",listener);
				this.triggerOnReady(true);
			}
		}.bind(this);
		document.addEventListener("readystatechange",listener,{ capture:true, passive:true, once:false });
	}
	setReadyOnRaf(){
		if(!this.onReadyListeners) return;
		animFrameHelper.onceRAF(this,'readyOnRaf',this.triggerOnReady.bind(this));
	}
	
	isReady(){ return !this.onReadyListeners; }
	isDOMReady(){ return !this.onDOMReadyListeners; }
	triggerOnReady(domComplete=false){
		this.checkPendingConnectElements();
		if(this.onReadyListeners){
			let list = this.onReadyListeners.values();
			this.onReadyListeners = null;
			this.isDuringOnReady = true;
			for(const cb of list) try{ cb(); }catch(err){ console.error(err); }
			this.scopeCtrl.$emit("$update");
			deferFn(()=>{ this.isDuringOnReady=false; });
		}
		if(this.onDOMReadyListeners && domComplete){
			let list = this.onDOMReadyListeners.values();
			this.onDOMReadyListeners = null;
			for(const cb of list) try{ cb(); }catch(err){ console.error(err); }
		}
	}
	/**
	 * Listen for when the DOM is first interactive or complete
	 * @param {Function} cb Callback
	 * @param {boolean=} delay Defer microtask or run instantly
	 */
	onReady(cb,delay=true){
		if(this.onReadyListeners) this.onReadyListeners.add(cb);
		else if(delay) deferFn(cb);
		else cb();
	}
	/**
	 * Listen for when the DOM is complete
	 * @param {Function} cb Callback
	 * @param {boolean=} delay Defer microtask or run instantly
	 */
	onDOMReady(cb,delay=true){
		if(this.onDOMReadyListeners) this.onDOMReadyListeners.add(cb);
		else if(delay) deferFn(cb);
		else cb();
	}
	
	/**
	 * @param {HTMLElement} element
	 * @param {Function} cb
	 */
	onElementLoaded(element,cb){
		if(isElementLoaded(element)) try{ cb(); }catch(err){ console.error(err); }
		else {
			if(!this.pendingOnElementLoaded.has(element)) this.pendingOnElementLoaded.set(element,new Set());
			this.pendingOnElementLoaded.get(element).add(cb);
		}
	}
	/**
	 * @param {HTMLElement} element
	 * @param {boolean=} checkParents
	 */
	isElementIgnored(element,checkParents=false){
		for(let e=element; e; e=checkParents?e.parentNode:null){
			if(this.ignoreNodes.has(e)) return true;
			if(e.nodeType===elementNodeType && e.hasAttribute(this.options.attribIgnore)){
				this.ignoreNodes.add(e);
				return true;
			}
		}
		return false;
	}
	
	// Element Connection
	/**
	 * Connect elements
	 * @param {HTMLElement} element
	 */
	connectElementAndChildren(element,act=true,list=new Set(),checkIgnoreParents=false){ // Connect parent before children
		if(element.nodeType===commentNodeType){ this.connectElement(element); return; }
		if(element.nodeType!==elementNodeType || element.nodeName==='SCRIPT' || element.nodeName==='STYLE') return;
		if(this.isElementIgnored(element,checkIgnoreParents)) return;
		list.add(element);
		if(element.childNodes && element.nodeName!=='TEMPLATE' && element.nodeName!=='svg' && !element.shadowRoot) for(let e of [...element.childNodes]) this.connectElementAndChildren(e,false,list);
		if(act) for(let e of list.values()) if(e.isConnected) this.connectElement(e);
	}
	/**
	 * Disconnect Elements
	 * @param {HTMLElement} element
	 */
	disconnectElementAndChildren(element,act=true,list=new Set()){ // Disconnect children before parent
		if(this.isElementIgnored(element,true)) return;
		if(element.childNodes) for(let e of [...element.childNodes]) this.disconnectElementAndChildren(e,false,list);
		list.add(element);
		if(act) for(let e of list.values()) if(!e.isConnected) this.disconnectElement(e);
	}
	/**
	 * Connect Specific Element
	 * @param {HTMLElement} element
	 */
	connectElement(element){
		if(this.pendingConnectNodes.has(element) && !isElementLoaded(element,true)) return;
		if(element!==this.mainElement && !isElementLoaded(element,true)){ this.pendingConnectNodes.add(element); return; }
		if(this.cacheConnectedNodes.has(element)) return;
		this.cacheConnectedNodes.add(element);
		this.pendingConnectNodes.delete(element);
		this.triggerElementConnect(element);
	}
	/**
	 * Disconnect Specific Element
	 * @param {HTMLElement} element
	 */
	disconnectElement(element){
		if(!this.cacheConnectedNodes.has(element)){ this.cleanupDisconnected(element); return; }
		this.triggerElementDisconnect(element);
		this.cleanupDisconnected(element,true);
	}
	checkPendingConnectElements(){
		for(let e of this.pendingConnectNodes) if(isElementLoaded(e,true)) this.connectElementAndChildren(e);
		for(let [e,cbList] of this.pendingOnElementLoaded) if(isElementLoaded(e)){
			for(let cb of cbList) try{ cbList.delete(cb); cb(); }catch(err){ console.error(err); }
			this.pendingOnElementLoaded.delete(e);
		}
	}
	
	// Attrib Handling
	/**
	 * @param {HTMLElement} element
	 * @returns {Map<string,scopeElementAttrib>|null}
	 */
	elementAttribs(element,useCache=true,checkConnected=true){
		if(checkConnected && (!this.cacheConnectedNodes.has(element) || !element.isConnected)) return null;
		if(useCache && this.cacheElementAttribs.has(element)) return this.cacheElementAttribs.get(element);
		let rawAttribs = element.attributes;
		if(!rawAttribs) return null;
		let attribs = new Map(), rawAliases = this.options.attributeAliases||null, nkAliases = this.options.attributeAliasNameKeys||null;
		for(let { name:aName, value } of rawAttribs){
			if(rawAliases && hasOwn(rawAliases,aName)) aName = rawAliases[aName];
			let [ _, nameFull, optionFull ] = regexExec(aName,this.options.attribRegexMatch) || [];
			if(nameFull===void 0 || nameFull.length===0) continue;
			let nameParts = regexMatchAllFirstGroup(nameFull,this.options.attribRegexParts);
			if(nameParts.length<=0) continue;
			if(value?.length===0) value = null;
			let isDefault = nameParts[0]==='default';
			let nameKey = nameParts.join(' ');
			if(nkAliases && hasOwn(nkAliases,nameKey)) nameKey = nkAliases[nameKey];
			let attrib = attribs.get(nameKey);
			if(!attrib) attribs.set(nameKey,attrib={ __proto__:null, ...scopeElementAttribDefaults, isDefault, attribute:aName, nameKey, nameParts, value:null, options:new Map() });
			if(optionFull!==void 0 && optionFull.length>0){
				let optionParts = regexMatchAllFirstGroup(optionFull,this.options.attribRegexParts);
				let optionKey = optionParts.join(' ');
				attrib.options.set(optionKey,{ __proto__:null, ...scopeElementAttribOptionDefaults, isDefault, attribute:aName, nameKey:optionKey, optionParts, value });
			}
			else attrib.value = value;
		}
		if(useCache && attribs.size>0) this.cacheElementAttribs.set(element,attribs);
		return attribs;
	}
	
	/**
	 * @param {HTMLElement} element
	 * @returns {Map<string,scopeElementAttrib>|null}
	 */
	elementFindDefaults(element,useCache=true,checkConnected=true){
		if(checkConnected && (!this.cacheConnectedNodes.has(element) || !element.isConnected)) return null;
		if(useCache && this.cacheElementAttribsDefaults.has(element)) return this.cacheElementAttribsDefaults.get(element);
		let defaults = new Map(), nkAliases = this.options.attributeAliasNameKeys||null;
		for(let e=element; e; e=e.parentNode){
			let attribs = this.elementAttribs(e,useCache,checkConnected);
			if(!attribs || attribs.size===0) continue;
			for(let [attribName,attrib] of attribs){
				let { nameParts, attribute, options } = attrib;
				if(options.size===0 || nameParts.length<=1 || nameParts[0]!=='default') continue;
				nameParts = nameParts.slice(1);
				let nameKey = nameParts.join(' ');
				if(nkAliases && hasOwn(nkAliases,nameKey)) nameKey = nkAliases[nameKey];
				let defaultAttrib = defaults.get(nameKey);
				if(!defaultAttrib) defaults.set(nameKey,defaultAttrib={ __proto__:null, ...scopeElementAttribDefaults, isDefault:true, attribute, nameKey, nameParts, value:null, options:new Map() });
				for(let [optKey,option] of options){
					if(!defaultAttrib.options.has(optKey)) defaultAttrib.options.set(optKey,option);
				}
			}
		}
		if(useCache && defaults.size>0) this.cacheElementAttribsDefaults.set(element,defaults);
		return defaults;
	}
	
	/**
	 * @param {HTMLElement} element
	 * @param {scopeElementAttrib} attrib
	 * @returns {scopeElementAttribOption}
	 */
	elementAttribOptionsWithDefaults(element,attrib,useCache=true,checkConnected=true){
		let { nameKey, nameParts, options } = attrib;
		if(nameParts[0]!=='default'){
			let defaultOptions = this.elementFindDefaults(element,useCache,checkConnected);
			if(defaultOptions?.get(nameKey)?.options?.size>0) return new Map([...defaultOptions.get(nameKey).options,...options]);
		}
		return options;
	}
	
	/**
	 * @param {scopeElementAttrib} attrib
	 * @param {Array<string>|Set<string>|null} whitelist
	 * @returns {string|null}
	 */
	elementAttribFallbackOptionValue(attrib,whitelist=null,updateOption=true,updateAttrib=true){
		let { options, attribute, value } = attrib;
		if(whitelist instanceof Array) whitelist = new Set(whitelist);
		for(let [optionKey,opt] of options){
			if(!whitelist || whitelist?.has?.(optionKey)){
				if(!opt.isDefault && opt.value?.length>0){
					attribute = opt.attribute;
					value = opt.value;
					if(updateOption) opt.value = '';
				}
			}
		}
		if(updateAttrib){
			attrib.attribute = attribute;
			attrib.value = value;
		}
		return value;
	}
	
	/**
	 * @param {HTMLElement} element
	 * @param {Map<string,scopeElementAttribOption>} attribOpts
	 * @param {string} optName
	 * @param {object|any} parseOptions
	 */
	elementAttribParseOption(element,attribOpts,optName,parseOptions={}){
		parseOptions = { __proto__:null, default:null, emptyTrue:false, runExp:false, ...parseOptions };
		let optValue = parseOptions.default, opt = attribOpts.get(optName), isDefault = opt?.isDefault;
		if(parseOptions.emptyTrue && (opt?.value==='' || opt?.value===null)) optValue = true;
		else if(!parseOptions.runExp && opt?.value?.length>0) optValue = opt.value;
		else if(parseOptions.runExp && opt?.value?.length>0){
			let { result } = this.elementExecExp(this.elementScopeCtrl(element),opt.value,{ $attribute:opt.attribute },{ silentHas:true, useReturn:true });
			if(typeof result!==void 0) optValue = result;
		}
		return { value:optValue, raw:opt?.value, attribOption:opt, isDefault };
	}
	
	// New Scope Controller
	/**
	 * @param {HTMLElement} element
	 */
	elementNewScopeCtrl(element,newScope=void 0,parentScopeCtrl=this.scopeCtrl,insertCache=true){
		if(parentScopeCtrl instanceof scopeElementController) parentScopeCtrl = parentScopeCtrl.ctrl;
		let scopeCtrl = new scopeController(newScope,parentScopeCtrl.eventTarget,parentScopeCtrl,false,this);
		let elementScopeCtrl = new scopeElementController(element,null,scopeCtrl);
		if(insertCache) this.cacheElementScopeCtrls.set(element,elementScopeCtrl);
		return elementScopeCtrl;
	}
	/**
	 * @param {HTMLElement} element
	 */
	elementNewIsolatedScopeCtrl(element,newScope=void 0,parentScopeCtrl=this.scopeCtrl,insertCache=true){
		if(parentScopeCtrl instanceof scopeElementController) parentScopeCtrl = parentScopeCtrl.ctrl;
		let scopeCtrl = new scopeController(newScope,null,parentScopeCtrl,true,this);
		let elementScopeCtrl = new scopeElementController(element,null,scopeCtrl);
		if(insertCache) this.cacheElementScopeCtrls.set(element,elementScopeCtrl);
		return elementScopeCtrl;
	}
	/**
	 * @param {HTMLElement} toElement
	 * @param {HTMLElement} fromElement
	 */
	elementScopeSetAlias(toElement,fromElement){
		// Element Scopes
		//let fromScopeList = this.elementExtraScopes.get(fromElement);
		let toScopeList = this.elementExtraScopes.get(toElement);
		if(!toScopeList) this.elementExtraScopes.set(toElement,[fromElement]);
		else if(toScopeList.indexOf(fromElement)===-1) toScopeList.push(fromElement);
		// Isolated Scopess
		let fromIsolated = this.elementIsolatedScopes.has(fromElement);
		let toIsolated = this.elementIsolatedScopes.has(toElement);
		if(fromIsolated && !toIsolated) this.elementIsolatedScopes.add(toElement);
		// Scope Controller
		let fromScopeCtrl = this.cacheElementScopeCtrls.get(fromElement);
		let toScopeCtrl = this.cacheElementScopeCtrls.has(toElement);
		if(fromScopeCtrl && !toScopeCtrl){
			let eCtrl = new scopeElementController(toElement,void 0,fromScopeCtrl);
			this.cacheElementScopeCtrls.set(toElement,eCtrl);
		}
	}
	
	// Find Scope Controller
	/**
	 * @param {HTMLElement} element
	 * @param {boolean} useCache
	 * @param {boolean} findParent
	 * @param {scopeBase|object|null} newScope
	 */
	elementScopeCtrl(element,useCache=true,findParent=true,newScope=null){
		if(useCache && this.cacheElementScopeCtrls.has(element)) return this.cacheElementScopeCtrls.get(element);
		let parentCtrl = findParent ? this.elementFindParentScopeCtrl(element) : null;
		if(parentCtrl && parentCtrl.element===element) return parentCtrl;
		if(!parentCtrl && findParent) parentCtrl = this.scopeCtrl;
		let ctrl = new scopeElementController(element,newScope,parentCtrl);
		if(useCache) this.cacheElementScopeCtrls.set(element,ctrl);
		return ctrl;
	}
	/**
	 * @param {HTMLElement} element
	 */
	elementFindParentScopeCtrl(element){
		for(let e=element; e; e=e.parentNode){
			if(!this.cacheConnectedNodes.has(e) && element.nodeType!==textNodeType) return;
			if(this.cacheElementScopeCtrls.has(e)) return this.cacheElementScopeCtrls.get(e);
		}
	}
	
	// Execute Expression on Element
	/**
	 * @param {scopeElementController} elementScopeCtrl
	 * @param {string} expression
	 * @param {object|null} extra
	 * @param {object=} options
	 */
	elementExecExp(elementScopeCtrl,expression,extra=null,options={}){
		let extraScopes = extra?[extra]:[], elementScopes = this.getElementScopes(elementScopeCtrl.element);
		let { globalContext, documentContext, signalProxyAll } = this.options;
		options = { __proto__:null, globalsHide:!globalContext, hideDocument:!documentContext, useSignalProxy:!!signalProxyAll, ...options };
		return elementScopeCtrl.execElementExpression(expression,extraScopes,elementScopes,options);
	}
	// Get Element Scopes [[element,scopesArr],...]
	/**
	 * @param {HTMLElement} element
	 * @param {Array<object>} eScopes
	 */
	getElementScopes(element,eScopes=[]){
		for(let e=element; e; e=e.parentNode){
			let isolated = this.elementIsolatedScopes.has(e) ? e : null;
			if(this.elementExtraScopes.has(e)) eScopes.push([e,this.resolveElementScopes(e,isolated)]);
			if(isolated) break;
		}
		return eScopes;
	}
	/**
	 * @param {HTMLElement} key
	 * @param {HTMLElement|null} isolated
	 * @param {Set<HTMLElement>} uniqueKeys
	 * @param {Array<object>} list
	 * @returns {Array<object>}
	 */
	resolveElementScopes(key,isolated=null,uniqueKeys=new Set([key]),list=[]){
		let arr = this.elementExtraScopes.get(key), isolatedParent = isolated?.parentNode;
		for(let i=0,l=arr.length; i<l; i++){
			let item = arr[i];
			if(item instanceof nodeProto.constructor){ // Flatten
				if(isolated){
					let isChildOrSibling = false;
					for(let e=item; e; e=e.parentNode) if(e===isolated || e===isolatedParent){ isChildOrSibling=true; break; }
					if(!isChildOrSibling) continue;
				}
				if(uniqueKeys.has(item)) continue; // Prevent endless recursion
				if(!this.elementExtraScopes.has(item)) continue; // Ignore other nodes/elements in scope list
				uniqueKeys.add(item);
				list = list.concat(this.resolveElementScopes(item,isolated,uniqueKeys));
			}
			else list.push(item);
		}
		return list;
	}
	
	// Handle connect & disconnect
	/**
	 * @param {HTMLElement} element
	 * @param {Function} removeListener
	 */
	registerElementRelatedEvent(element,removeListener){
		let map = this.elementRelatedEventListeners;
		if(!map.has(element)) map.set(element,new Set());
		map.get(element).add(removeListener);
	}
	/**
	 * @param {HTMLElement} element
	 */
	removeElementRelatedEvents(element){
		let map = this.elementRelatedEventListeners;
		if(map.has(element)){
			let set = map.get(element);
			for(let removeListener of set) removeListener();
			map.delete(element);
		}
	}
	
	/**
	 * Gets signal for given expression. If it doesnt exist, create one.
	 * Useful for making sure a variable exists, to be usable elsewhere.
	 * Returns { signal, expFn } - expFn is an expression function that returns the expression's result
	 * @param {Element} element Element for elementScopeController instance
	 * @param {string} key Expression (scope variable name)
	 */
	ensureExpressionSignal(element,key){
		let elementScopeCtrl = this.elementScopeCtrl(element);
		let { runFn:expFn } = this.elementExecExp(elementScopeCtrl,`${key}`,null,{ __proto__:null, run:false, useReturn:true, useSignalProxy:true });
		let signal = resolveSignal(expFn(),null,true);
		if(!signal){
			signal = this.scopeCtrl.signalCtrl.createSignal();
			let { runFn } = this.elementExecExp(elementScopeCtrl,`${key}=$$signal`,null,{ __proto__:null, run:false, useReturn:true, useSignalProxy:true, argument:'$$signal' });
			let result = runFn(signal);
			if(result!==signal) signal = null;
		}
		return { signal, expFn };
	}
	
	/**
	 * @param {HTMLElement} element
	 */
	triggerElementConnect(element){
		let attribs = this.elementAttribs(element), elementScopeCtrl, queue=[];
		if(attribs && attribs.size>0){
			elementScopeCtrl = this.elementScopeCtrl(element);
			// Swap
			if(element.nodeName==='TEMPLATE' && attribs.has('swap')){
				let anchor = document.createComment(' Template-Swap-Anchor: '+element.cloneNode(false).outerHTML+' ');
				element.parentNode.replaceChild(anchor,element);
				this.onElementLoaded(anchor,()=>{
					let swap = attribs.get('swap'), fragment=element.content, dom=fragment;
					element.removeAttribute(swap.attribute);
					if(swap?.value?.length>0){
						dom = document.createElement(swap.value);
						for(let a of element.attributes) dom.attributes.setNamedItem(a.cloneNode(false));
						dom.appendChild(fragment);
					}
					anchor.parentNode.replaceChild(dom,anchor);
				});
				return;
			}
			// Scope
			let scopeAttrib = attribs.get('scope'), scopeNamedAttrib = attribs.get('scope name');
			if(scopeAttrib || scopeNamedAttrib){
				if(scopeAttrib && scopeNamedAttrib && scopeNamedAttrib.options.size>0) scopeAttrib.options = new Map([...scopeAttrib.options,...scopeNamedAttrib.options]);
				if(!scopeAttrib) scopeAttrib = scopeNamedAttrib;
				let options = this.elementAttribOptionsWithDefaults(element,scopeAttrib);
				if(scopeAttrib.value===null) this.elementAttribFallbackOptionValue(scopeAttrib,['isolate']);
				let isolated = options.get('isolate'), { value, attribute:$attribute } = scopeAttrib; // After fallback
				let exp = value, extra = { __proto__:null, $attribute }, expOpts = { __proto__:null, run:true, useReturn:true };
				// Prepare Named Scope
				if(scopeNamedAttrib){
					if(scopeNamedAttrib.value?.length>0) value = scopeNamedAttrib.value;
					let name = value, ctrl = this.namedControllers.get(name);
					if(!ctrl){ console.warn(`ScopeDom: scopeController "${name}" doesn't exist`); return; }
					if(ctrl.element && ctrl.element!==element){ console.warn(`ScopeDom: scopeController "${name}" is already in use`,{ ctrlElement:ctrl.element, newElement:element }); return; }
					ctrl.element = element;
					extra = { __proto__:null, _ctrlFn:ctrl.fn };
					exp = `{ __proto__:null, _ctrlFn, $scopeElement:$this }`;
				}
				// New Scope
				if(exp!==null){
					// Run new scope expression normally, with parent scope
					let { result } = this.elementExecExp(elementScopeCtrl,exp,extra,expOpts);
					result = result ? Object(result) : void 0;
					let originalScopeCtrl = elementScopeCtrl; // Use originalScopeCtrl as $scopeParent
					if(isolated) this.elementIsolatedScopes.add(element);
					if(isolated) elementScopeCtrl = this.elementNewIsolatedScopeCtrl(element,result||void 0,originalScopeCtrl,true);
					else elementScopeCtrl = this.elementNewScopeCtrl(element,result||void 0,originalScopeCtrl,true);
				}
				// Run Named Scope Controller
				if(scopeNamedAttrib){
					expOpts = { __proto__:null, ...expOpts, fnThis:null, useReturn:false }; // fnThis:null sets 'this' as proxy
					exp = `((fn)=>{ this._ctrlFn=void 0; instance.handleScopeCtrlFn(this,fn); })(_ctrlFn);`;
					this.elementExecExp(elementScopeCtrl,exp,{ __proto__:null, instance:this },expOpts);
				}
			}
			// Other built-in attribs
			for(let [attribName,attrib] of attribs){
				let { nameParts, value } = attrib;
				if(nameParts[0]==='default') continue;
				let options = this.elementAttribOptionsWithDefaults(element,attrib);
				// Init / Connect
				if(nameParts.length===1){
					let [ name ] = nameParts;
					if(name==='init' || name==='connect'){
						if(value===null) value = this.elementAttribFallbackOptionValue(attrib,['raf','instant']);
						let { attribute:$attribute } = attrib;
						let raf = options.get('raf'), instant = options.get('instant');
						if(value?.length>0){
							let { runFn:connectCB } = this.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
							queue.push(function attribConnect(){
								if(raf && !animFrameHelper.isDuringRAF) animFrameHelper.onceRAF(element,$attribute,connectCB);
								else if(instant) connectCB();
								else deferFn(connectCB);
							});
							continue;
						}
					}
				}
				// Listen for Update Scope
				if(nameParts.length===1 || nameParts.length===2){
					let [ type, name ] = nameParts, suffix = null;
					if(type==='update' && value===null){
						value = this.elementAttribFallbackOptionValue(attrib,['before','after']);
						if(options.get('before')) suffix=':before';
						if(options.get('after')) suffix=':after';
					}
					if(type==='update' && value?.length>0){
						let { attribute:$attribute } = attrib;
						let { runFn:updateCB } = this.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
						// Register events straight away
						let evt = '$update'+(name?.length>0?'-'+name:'')+(suffix!==null?suffix:'');
						let removeListener = elementScopeCtrl.ctrl.$on(evt,()=>updateCB(),{},true);
						this.registerElementRelatedEvent(element,removeListener);
						continue;
					}
				}
				// Signal Attribute (lowercase keys)
				if(nameParts.length===2){
					let [ name, key ] = nameParts;
					if(name==='signal' && key?.length>0){
						let { attribute:$attribute } = attrib, watchOpt = options.get('watch'), computeOpt = options.get('compute');
						// Watch Signal
						let watchValue = watchOpt?.value?.length>0 ? watchOpt.value : value;
						if(watchValue?.length>0 && !watchOpt.isDefault && (!computeOpt || computeOpt?.value!==watchValue)){
							let { signal, expFn } = this.ensureExpressionSignal(element,key);
							if(signal){
								let obs = this.scopeCtrl.signalCtrl.createObserver(); obs.recordSignal(signal);
								let oldValue, extra = { __proto__:null, $attribute, get $value(){ return signal?.get(); }, get $oldValue(){ return oldValue; } };
								let { runFn:watchFn } = this.elementExecExp(elementScopeCtrl,watchValue,extra,{ __proto__:null, run:false });
								watchFn = obs.wrapRecorder(watchFn);
								obs.addListener(function attribSignalWatchValue(obs,s,o){ oldValue=o; watchFn(); });
								this.registerElementRelatedEvent(element,obs.clear.bind(obs));
							}
						}
						// Compute Signal
						if(computeOpt?.value?.length>0 && !computeOpt.isDefault){
							let { signal } = this.ensureExpressionSignal(element,key);
							if(signal){
								let { runFn:computeFn } = this.elementExecExp(elementScopeCtrl,computeOpt.value,{ __proto__:null, $attribute },{ __proto__:null, run:false, useReturn:true });
								let [ _, obs, clear ] = this.scopeCtrl.signalCtrl.computeSignal(function attribSignalCompute(){ return resolveSignal(computeFn()); },{ pull:true, signal });
								this.registerElementRelatedEvent(element,clear);
							}
						}
					}
				}
				// Events
				if(nameParts.length===2){
					let [ type, eventName ] = nameParts;
					if(type==='on'){ nameParts = [ type,'dom',eventName ]; }
					else if(type==='once'){ nameParts = [ type,'dom',eventName ]; }
				}
				if(nameParts.length===3 && (nameParts[0]==='on' || nameParts[0]==='once')){
					let [ type, target, eventName ] = nameParts;
					let evtBase=null, evtMethod=null, evtTarget=null;
					if(type==='on' && target==='dom'){ evtBase = elementScopeCtrl; evtMethod = '$onDom'; }
					else if(type==='once' && target==='dom'){ evtBase = elementScopeCtrl; evtMethod = '$onceDom'; }
					else if(type==='on' && target==='scope'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$on'; }
					else if(type==='once' && target==='scope'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$once'; }
					else if(type==='on' && target==='window'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onTarget'; evtTarget=window; }
					else if(type==='once' && target==='window'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onceTarget'; evtTarget=window; }
					else if(type==='on' && target==='document'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onTarget'; evtTarget=document; }
					else if(type==='once' && target==='document'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onceTarget'; evtTarget=document; }
					if(evtBase && evtMethod){
						if(value===null) value = this.elementAttribFallbackOptionValue(attrib,['raf','instant','pd']);
						let { attribute:$attribute } = attrib;
						let raf = options.get('raf'), instant = options.get('instant'), pd = options.get('pd');
						if(value?.length>0){
							let self=this, { runFn:eventCB, firstScope } = this.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
							/**
							 * @param {{ preventDefault: () => void; }} event
							 */
							function eventListener(event){
								if(pd) event.preventDefault();
								firstScope.$event = event;
								if(animFrameHelper.isDuringRAF || self.isDuringOnReady) eventCB();
								else if(raf) animFrameHelper.onceRAF(element,$attribute,eventCB);
								else if(instant) eventCB();
								else deferFn(eventCB);
								if(pd) return false;
							};
							// Register events straight away
							let removeListener = evtTarget ? evtBase[evtMethod](evtTarget,eventName,eventListener,{},true) : evtBase[evtMethod](eventName,eventListener,{},true);
							this.registerElementRelatedEvent(element,removeListener);
							continue;
						}
					}
				}
			}
		}
		if(queue.length>0) this.onReady(function onReadyConnect(){ for(let cb of queue) cb.apply(this); }.bind(this),false);
		// Run plugins onConnect
		this.pluginsOnConnect(new pluginOnElementPlug(this,element,elementScopeCtrl,attribs));
	}
	
	/**
	 * @param {HTMLElement} element
	 */
	triggerElementDisconnect(element){
		if(!this.cacheConnectedNodes.has(element)) return;
		let attribs = this.elementAttribs(element,true,false), elementScopeCtrl;
		if(attribs && attribs.size>0){
			elementScopeCtrl = this.elementScopeCtrl(element);
			for(let [attribName,attrib] of attribs){
				let { nameParts, value, attribute:$attribute } = attrib;
				if(nameParts[0]==='default') continue;
				let options = this.elementAttribOptionsWithDefaults(element,attrib);
				if(nameParts.length===1){
					let [ name ] = nameParts;
					if(name==='deinit' || name==='disconnect'){
						if(value===null) value = this.elementAttribFallbackOptionValue(attrib,['raf','instant']);
						let { attribute:$attribute } = attrib;
						let raf = options.get('raf'), instant = options.get('instant');
						if(value?.length>0){
							let { runFn:disconnectCB } = this.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
							if(raf && !animFrameHelper.isDuringRAF) animFrameHelper.requestAF(disconnectCB);
							else if(instant || animFrameHelper.isDuringRAF) disconnectCB();
							else deferFn(disconnectCB);
							continue;
						}
					}
				}
			}
		}
		// Run plugins onDisconnect
		this.pluginsOnDisconnect(new pluginOnElementPlug(this,element,elementScopeCtrl,attribs));
	}
	
	/**
	 * @param {WeakKey} element
	 */
	cleanupDisconnected(element,completely=false){
		if(this.cacheElementAttribs.has(element)) this.cacheElementAttribs.delete(element);
		if(this.cacheElementAttribsDefaults.has(element)) this.cacheElementAttribsDefaults.delete(element);
		if(this.cacheElementScopeCtrls.has(element)) this.cacheElementScopeCtrls.delete(element);
		if(this.elementExtraScopes.has(element)) this.elementExtraScopes.delete(element);
		if(this.elementIsolatedScopes.has(element)) this.elementIsolatedScopes.delete(element);
		this.removeElementRelatedEvents(element);
		this.scopeCtrl.eventRegistry.remove(element);
		if(completely){
			this.cacheConnectedNodes.delete(element);
			this.pendingConnectNodes.delete(element);
		}
	}
	
	// Plugins & Middleware
	/**
	 * @param {{ onConnect:Function, onDisconnect:Function, onPluginAdd:Function }|Function} plugin
	 */
	pluginAdd(plugin){
		if(!this.options.allowLatePlugins) throw console.log(this.options), new Error("ScopeDom: late plugin adding is disabled, due to instance { allowLatePlugins:false }");
		let plugins=this.plugins, register=plugins.register;
		if(register.has(plugin)) return true;
		register.add(plugin);
		if(typeof plugin==='function' && plugin?.prototype?.constructor){ plugin=new plugin(ScopeDom,this); register.add(plugin); }
		// Methods
		if(plugin.onConnect) plugins.onConnect.add(plugin.onConnect.bind(plugin));
		if(plugin.onDisconnect) plugins.onDisconnect.add(plugin.onDisconnect.bind(plugin));
		if(plugin.onPluginAdd) plugins.onPluginAdd.add(plugin.onPluginAdd.bind(plugin));
		if(plugin.onExpression) plugins.onExpression.add(plugin.onExpression.bind(plugin));
		// Late Connect
		if(plugins.init && plugin.onConnect && this.mainElement!==null) this.latePluginAdd_runConnect(plugin,this.mainElement,true);
		// onPluginAdd Method
		this.pluginsOnPluginAdd(plugin);
		return true;
	}
	
	initPlugins(){
		if(this.plugins.init) return;
		if(!this.options.allowLatePlugins) throw console.log(this.options), new Error("ScopeDom: late plugin adding is disabled, due to instance { allowLatePlugins:false }");
		for(let plugin of pluginsPostMain||Object.values(window.ScopeDomPlugins||[])||[]) this.pluginAdd(plugin);
		this.plugins.init=true;
	}
	
	/**
	 * @param {pluginOnElementPlug} plugObj
	 */
	pluginsOnConnect(plugObj){
		for(let pluginOnConnect of this.plugins.onConnect) try{ pluginOnConnect(plugObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * @param {pluginOnElementPlug} plugObj
	 */
	pluginsOnDisconnect(plugObj){
		for(let pluginOnDisconnect of this.plugins.onDisconnect) try{ pluginOnDisconnect(plugObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * @param {pluginOnElementPlug} plugObj
	 */
	pluginsOnPluginAdd(plugObj){
		for(let pluginOnPluginAdd of this.plugins.onPluginAdd) try{ pluginOnPluginAdd(plugObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * @param {ElementExpression} expObj
	 */
	pluginsOnElementExpression(expObj){
		for(let pluginOnExpression of this.plugins.onExpression) try{ pluginOnExpression(expObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * @param {{ onConnect:Function }} plugin
	 * @param {HTMLElement} element
	 */
	latePluginAdd_runConnect(plugin,element,act=true,list=new Set()){
		if(!plugin || !this.plugins.init || !this.cacheConnectedNodes.has(element)) return;
		list.add(element);
		if(element.childNodes) for(let e of [...element.childNodes]) this.latePluginAdd_runConnect(plugin,e,false,list);
		if(act && plugin.onConnect){
			let onConnect = plugin.onConnect.bind(plugin);
			for(let e of list){
				if(!e.isConnected) continue;
				let attribs = this.elementAttribs(e);
				if(!attribs || attribs.size===0) continue;
				try{ onConnect(new pluginOnElementPlug(this,e,this.elementScopeCtrl(e),attribs)); }catch(err){ console.error(err); }
			}
		}
	}
	
}

class pluginOnElementPlug {
	/**
	 * @param {ScopeDom} instance
	 * @param {HTMLElement} element
	 * @param {scopeElementController} elementScopeCtrl
	 * @param {Map<string,scopeElementAttrib>} attribs
	 */
	constructor(instance,element,elementScopeCtrl,attribs){
		this.instance = instance;
		this.element = element;
		this.elementScopeCtrl = elementScopeCtrl;
		this.attribs = attribs;
	}
}

class pluginOnElementExpression {
	/**
	 * @param {ScopeDom} instance
	 * @param {HTMLElement} element
	 * @param {scopeElementController} elementScopeCtrl
	 * @param {Map<string,scopeElementAttrib>} attribs
	 */
	constructor(instance,element,elementScopeCtrl,expObj){
		this.instance = instance;
		this.element = element;
		this.elementScopeCtrl = elementScopeCtrl;
		this.expressionObj = expObj;
	}
}

Object.assign(ScopeDom,{
	animFrameHelper,
	regexMatchAll, regexExec, regexTest,
	setAttribute,
	isElementLoaded,
	scopeInstance,
	scopeBase,
	execExpression,
	execExpressionProxy,
	signalController,
	signalObserver,
	signalProxy,
	signalInstance,
	resolveSignal,
	scopeController,
	scopeElementContext,
	scopeElementController,
	eventRegistry,
	pluginOnElementPlug,
	pluginOnElementExpression,
});

ScopeDom.setupScriptTag();

export { ScopeDom as default }
