
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

/**
 * Disables the document.defaultView property to prevent access.
 *
 * This function redefines document.defaultView to return a simplified object
 * containing getComputedStyle. It also logs a console warning when accessed.
 */
const disableDocumentDefaultView = ()=>{
	try{ defineProperty(window.document,'defaultView',{
		get(){ return console.warn("ScopeDom: document.defaultView is disabled"), { __proto__:null, getComputedStyle:window.getComputedStyle.bind(window) }; }
	}); }
	catch(e){ console.warn("ScopeDom: Failed to disable document.defaultView\n",e); }
}

/**
 * Default initialization options for ScopeDom.
 * 
 * @template {object} initOptionsDefaults
 * @typedef {object} initOptionsDefaults
 */
const initOptionsDefaults = {
	/** @type {boolean} Verbose developer logging */
	dev: true,
	/** @type {boolean} Regex for parsing attribute names */
	attribRegexMatch: /^\$((?:[\.\w\d]+)(?:\-[\.\w\d]+)*?)(?:\:((?:[\.\w\d]+)(?:\-[\.\w\d]+)*?))?$/, // group1: name, group2: option
	/** @type {boolean} Regex for parsing attribute parts */
	attribRegexParts: /([\.\w\d]+)/g,
	/** @type {boolean} Ignore attribute name */
	attribIgnore: '$ignore',
	// attribFormatTest: '$aa-bb-cc', // test these (if they exist), if fail, throw
	// attribOptionsFormatTest: '$aa-bb-cc:oa-ob',
	/** @type {boolean} Enable global context */
	globalContext: true,
	/** @type {boolean} Enable document context */
	documentContext: true,
	/** @type {boolean} Disable document default view */
	documentDefaultView: false,
	/** @type {scopeBase|object|null} Custom scope object */
	scope: null,
	/** @type {boolean} Attribute alias mappings */
	attributeAliases: null,
	/** @type {boolean} Attribute alias name key mappings */
	attributeAliasNameKeys: null,
	/** @type {boolean} Auto trigger ready callbacks */
	autoReady: true,
	/** @type {HTMLElement|null} Main Element (defaults to document.body) */
	element: null,
	/** @type {boolean} Prevent further instances */
	onlyInstance: true, // Prevent further instances
	/** @type {boolean} Enforce direct instance reference */
	privateInstance: false, // Enforces use of direct instance reference & prevent late plugins
	/** @type {boolean} Allow late plugin addition */
	allowLatePlugins: true, // Prevent pluginAdd after ScopeDom init (defaults to false on privateInstance)
	/** @type {boolean} Defer signals */
	signalDefer: true,
	/** @type {boolean} Proxy all signals */
	signalProxyAll: true,
};
let initOptionsScriptTag = null;

/**
 * Default values for scope element attributes.
 *
 * @template {object} scopeElementAttribDefaults
 * @typedef {object} scopeElementAttribDefaults
 */
const scopeElementAttribDefaults = {
	/** @type {boolean} If this is a default attribute */
	isDefault: true,
	/** @type {string|null} Original attribute name */
	attribute: null,
	/** @type {string|null} Name key for the attribute */
	nameKey: null,
	/** @type {string|null} Parts of the name */
	nameParts: null,
	/** @type {string|null} Attribute value */
	value: null,
	/** @type {Map<string,scopeElementAttribOptionDefaults>|null} Options map */
	options: null,
};

/**
 * Default values for scope element attribute options.
 * 
 * @template {object} scopeElementAttribOptionDefaults
 * @typedef {object} scopeElementAttribOptionDefaults
 */
const scopeElementAttribOptionDefaults = {
	/** @type {boolean} If this is a default attribute option */
	isDefault: false,
	/** @type {string|null} Original attribute name */
	attribute: null,
	/** @type {string|null} Name key for the option */
	nameKey: null,
	/** @type {Array<string>|null} String parts of the option */
	optionParts: null,
	/** @type {string|null} Option value */
	value: null
};

/**
 * Set containing all ScopeDom instances.
 * 
 * @type {Set<ScopeDom>}
 */
const allInstances = new Set();

/**
 * The main (first) ScopeDom instance.
 * 
 * @type {ScopeDom|null}
 */
let mainInstance = null;

/**
 * Restrict ScopeDom instances to only one.
 * 
 * @type {ScopeDom|null}
 */
let onlyInstance = null;

/**
 * Set of post-main plugins to be loaded after the main instance is created.
 * 
 * @type {Set<object|Function>|null}
 */
let pluginsPostMain = null;

/**
 * Object passed to scope controller callback function.
 * 
 * @typedef {object} ScopeDomCtrlCallbackObj
 * @property {Proxy|object|any} scope The proxy scope object
 * @property {ScopeDom} instance The ScopeDom instance
 * @property {scopeController} controller The scope controller
 * @property {typeof scopeController.prototype.$signal} signal Signal helper method
 * @property {typeof signalController.prototype.createSignal} createSignal Create signal method
 * @property {typeof signalController.prototype.defineSignal} defineSignal Define signal method
 * @property {typeof signalController.prototype.assignSignals} assignSignals Assign signals method
 * @property {typeof signalController.prototype.computeSignal} computeSignal Compute signal method
 * @property {typeof signalController.prototype.proxySignal} proxySignal Proxy signal method
 * @property {typeof signalController.prototype.defineProxySignal} defineProxySignal Define proxy signal method
 * @property {typeof signalController.prototype.preventUpdates} preventUpdates Prevent updates method
 * @property {typeof signalController.prototype.preventObservers} preventObservers Prevent observers method
 */

/**
 * Callback for scope controller functions.
 *
 * @callback ScopeDomCtrlCallback
 * @param {ScopeDomCtrlCallbackObj} detailsObject
 * @returns {void}
 */

/**
 * The main ScopeDom class for DOM manipulation and scope management.
 * 
 * Provides DOM scanning, watching, and connection capabilities along with scope controller management.
 * 
 * @class ScopeDom
 */
class ScopeDom {
	
	/**
	 * Parse script tag attributes.
	 * 
	 * data-scopedom-init attribute for automatic initialisation.
	 * data-scopedom-options attribute for initialisation options.
	 * 
	 * @static
	 */
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
	 * Initialise the main instance of ScopeDom.
	 *
	 * This method creates and initializes the main ScopeDom instance, then begins DOM watching.
	 * It should only be called once to set up the primary ScopeDom instance.
	 *
	 * @static
	 * @param {initOptionsDefaults|object|null} [initOptions] ScopeDom instance initialisation options
	 * @returns {ScopeDom} The newly created ScopeDom instance
	 * @throws {Error} If main instance has already been initialised
	 */
	static init(initOptions={}){
		if(mainInstance) throw new Error("ScopeDom: main instance is already initialised");
		let instance = new ScopeDom(initOptions);
		return instance.beginDomWatching(), instance;
	}
	
	/**
	 * Get the main instance of ScopeDom if it has already been initialised.
	 * 
	 * If the main instance is private, then an error is thrown.
	 * 
	 * @static
	 * @returns {ScopeDom} The main instance of ScopeDom
	 * @throws {Error} If the main instance has not yet been initialised, or if it's private
	 */
	static getInstance(){
		if(!mainInstance) throw new Error("ScopeDom: no main instance, use ScopeDom.init");
		if(mainInstance.options.privateInstance) throw new Error("ScopeDom: main instance is private, directly reference that instance instead");
		return mainInstance;
	}
	
	/**
	 * Define scope controller on main ScopeDom instance.
	 * 
	 * @static
	 * @param {Function|string|null} [name] Scope Controller Name
	 * @param {ScopeDomCtrlCallback} [fn] Scope Controller Function
	 * @returns {ScopeDom} ScopeDom instance
	 */
	static controller(name,fn){
		return ScopeDom.getInstance().controller(name,fn);
	}
	
	/**
	 * Add a plugin to all ScopeDom instances.
	 * 
	 * @param {object|Function} plugin Plugin object or constructor function
	 * @returns {boolean} True if plugin was added successfully
	 * @throws {Error} If late plugin adding is disabled
	 */
	static pluginAdd(plugin){
		if(mainInstance && !mainInstance.options.allowLatePlugins) throw new Error("ScopeDom: late plugin adding is disabled, due to main instance { allowLatePlugins:false }");
		for(let inst of allInstances){
			if(inst.options.allowLatePlugins) inst.pluginAdd(plugin) || console.error("ScopeDom: failed to add plugin to an instance");
		}
		return true;
	}
	
	/**
	 * Initialize a new ScopeDom instance
	 *
	 * @constructor
	 * @param {initOptionsDefaults|object|null} initOptions Configuration options for the instance
	 * @throws {Error} If a private instance is already initialized, if documentContext is false when globalContext isn't, or onlyInstance is true when the main instance already exists
	 */
	constructor(initOptions={}){
		if(onlyInstance) throw new Error("ScopeDom: a private instance is already initialised");
		initOptions = { __proto__:null, ...initOptionsScriptTag, ...initOptions };
		/** @type {initOptionsDefaults} Configuration options for this instance */
		let options = { __proto__:null, ...initOptionsDefaults, ...initOptions };
		if(!options.globalContext && options.documentContext && !options.documentDefaultView && window.document) disableDocumentDefaultView();
		else if(options.globalContext && !options.documentContext) throw new Error("ScopeDom: For documentContext to be false, globalContext must also be false");
		if(options.onlyInstance && mainInstance) throw new Error("ScopeDom: only the main (first) instance can use { onlyInstance:true }");
		if(options.onlyInstance) onlyInstance = this;
		if(!mainInstance) mainInstance = this;
		allInstances.add(this);
		let scope = options.scope===Object(options.scope) ? options.scope : new scopeBase();
		/** @type {initOptionsDefaults} Configuration options for this instance */
		this.options = options;
		/** @type {HTMLElement|null} The main element being watched */
		this.mainElement = options.element || null;
		/** @type {scopeController} The scope controller instance */
		this.scopeCtrl = new scopeController(scope,null,null,false,this);
		/** @type {Map} Named controllers map */
		this.namedControllers = new Map();
		/** @type {Map} Cache for DOM watchers */
		this.cacheWatchObservers = new Map();
		/** @type {WeakSet} Cache for connected nodes */
		this.cacheConnectedNodes = new WeakSet();
		/** @type {Set} Pending connection nodes */
		this.pendingConnectNodes = new Set();
		/** @type {Map} Pending element loaded callbacks */
		this.pendingOnElementLoaded = new Map();
		/** @type {WeakMap} Cache for element scope controllers */
		this.cacheElementScopeCtrls = new WeakMap();
		/** @type {WeakMap} Cache for element attributes */
		this.cacheElementAttribs = new WeakMap();
		/** @type {WeakMap} Cache for element attribute defaults */
		this.cacheElementAttribsDefaults = new WeakMap();
		/** @type {WeakSet} Nodes to ignore */
		this.ignoreNodes = new WeakSet();
		/** @type {WeakMap} Element-related event listeners */
		this.elementRelatedEventListeners = new WeakMap();
		/** @type {WeakMap} Element extra scopes */
		this.elementExtraScopes = new WeakMap(); // element -> array -> objects/elements
		/** @type {WeakMap} Element isolated scopes */
		this.elementIsolatedScopes = new WeakSet();
		/** @type {Set} Ready callbacks listeners */
		this.onReadyListeners = new Set();
		/** @type {Set} DOM ready callbacks listeners */
		this.onDOMReadyListeners = new Set();
		/** @type {boolean} Flag indicating if currently executing onReady callbacks */
		this.isDuringOnReady = false;
		// Plugins
		/** @type {object} Plugin system object */
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
	 * Start a MutationObserver to observe for changes on the DOM.
	 * 
	 * Begins watching the main element or document.body for DOM changes.
	 * Triggers scanning and ready callbacks when main element is found.
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
	 * Define scope controller.
	 * 
	 * @param {Function|string|null} name Scope Controller Name
	 * @param {ScopeDomCtrlCallback} fn Scope Controller Function
	 * @returns {ScopeDom} ScopeDom instance
	 * @throws {Error} If arguments are incorrect, or if the named controller already exists
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
	
	/**
	 * Handle scope controller function execution.
	 * 
	 * An object is passed as the only function argument, with scope (Proxy), instance, controller, and most signal helper methods.
	 * 
	 * @param {Proxy|object} proxy The proxy object for scope access
	 * @param {ScopeDomCtrlCallback} fn The controller function to execute
	 */
	handleScopeCtrlFn(proxy,fn){
		let signal = this.scopeCtrl.$signal.bind(this.scopeCtrl); // signal(value) : [get,set,signal]
		let signalCtrl = this.scopeCtrl.signalCtrl, signalMethods = Object.fromEntries(
			['createSignal','defineSignal','assignSignals','computeSignal','proxySignal','defineProxySignal','preventUpdates','preventObservers']
			.map(k=>[k,signalCtrl[k].bind(signalCtrl)])
		);
		fn.apply(proxy,[{ scope:proxy, instance:this, controller:this.scopeCtrl, signal, ...signalMethods }]);
	}
	
	// Element Scanning & Watching
	
	/**
	 * Scan and connect DOM tree.
	 * 
	 * Alias of connectElementAndChildren.
	 * 
	 * @param {...*} args Arguments passed to connectElementAndChildren
	 */
	scanDomTree(...args){ return this.connectElementAndChildren(...args); }
	
	/**
	 * Watch DOM tree for changes using MutationObserver.
	 * 
	 * @param {HTMLElement} element The element to watch
	 */
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
	
	/**
	 * Set up ready callback when DOM becomes interactive or complete.
	 * 
	 * Triggers onReady immediately if DOM is already loaded.
	 * 
	 * @param {boolean} domComplete DOM is complete
	 */
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
	
	/**
	 * Set up ready callback to fire on next requestAnimationFrame.
	 */
	setReadyOnRaf(){
		if(!this.onReadyListeners) return;
		animFrameHelper.onceRAF(this,'readyOnRaf',this.triggerOnReady.bind(this));
	}
	
	/**
	 * Check if all ready callbacks have been triggered.
	 * 
	 * @returns {boolean} True if ready
	 */
	isReady(){ return !this.onReadyListeners; }
	
	/**
	 * Check if DOM is ready (all DOM ready callbacks triggered).
	 * 
	 * @returns {boolean} True if DOM is ready
	 */
	isDOMReady(){ return !this.onDOMReadyListeners; }
	
	/**
	 * Trigger all registered ready callbacks.
	 * 
	 * @param {boolean} [domComplete=false] DOM is complete
	 */
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
	 * Listen for when the DOM is first interactive or complete.
	 * 
	 * @param {Function} cb Callback function to execute
	 * @param {boolean} [delay=true] Defer microtask or run instantly
	 */
	onReady(cb,delay=true){
		if(this.onReadyListeners) this.onReadyListeners.add(cb);
		else if(delay) deferFn(cb);
		else cb();
	}
	
	/**
	 * Listen for when the DOM is complete.
	 * 
	 * @param {Function} cb Callback function to execute
	 * @param {boolean} [defer=true] Defer to microtask
	 */
	onDOMReady(cb,defer=true){
		if(this.onDOMReadyListeners) this.onDOMReadyListeners.add(cb);
		else if(defer) deferFn(cb);
		else cb();
	}
	
	/**
	 * Register a callback to be called when an element is loaded.
	 * 
	 * @param {HTMLElement} element The element to watch
	 * @param {Function} cb Callback function to execute when element is loaded
	 */
	onElementLoaded(element,cb){
		if(isElementLoaded(element)) try{ cb(); }catch(err){ console.error(err); }
		else {
			if(!this.pendingOnElementLoaded.has(element)) this.pendingOnElementLoaded.set(element,new Set());
			this.pendingOnElementLoaded.get(element).add(cb);
		}
	}
	
	/**
	 * Check if an element should be ignored based on ignore attributes.
	 * 
	 * @param {HTMLElement} element The element to check
	 * @param {boolean} [checkParents=false] Check parent elements
	 * @returns {boolean} True if element should be ignored
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
	 * Connect an element and all its children.
	 * 
	 * @param {HTMLElement} element The element to connect
	 * @param {boolean} [act=true] Connect elements
	 * @param {Set} [list] Set of elements being processed
	 * @param {boolean} [checkIgnoreParents=false] Check parent elements for ignore attributes
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
	 * Disconnect an element and all its children.
	 * 
	 * @param {HTMLElement} element The element to disconnect
	 * @param {boolean} [act=true] Disconnect elements
	 * @param {Set} [list] Set of elements being processed
	 */
	disconnectElementAndChildren(element,act=true,list=new Set()){ // Disconnect children before parent
		if(this.isElementIgnored(element,true)) return;
		if(element.childNodes) for(let e of [...element.childNodes]) this.disconnectElementAndChildren(e,false,list);
		list.add(element);
		if(act) for(let e of list.values()) if(!e.isConnected) this.disconnectElement(e);
	}
	
	/**
	 * Element is being connected (added into DOM).
	 * 
	 * @param {HTMLElement} element Connected element
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
	 * Element is being disconnected (removed from DOM).
	 * 
	 * @param {HTMLElement} element Disconnected element
	 */
	disconnectElement(element){
		if(!this.cacheConnectedNodes.has(element)){ this.cleanupDisconnected(element); return; }
		this.triggerElementDisconnect(element);
		this.cleanupDisconnected(element,true);
	}
	
	/**
	 * Check and connect pending elements that are now loaded.
	 */
	checkPendingConnectElements(){
		for(let e of this.pendingConnectNodes) if(isElementLoaded(e,true)) this.connectElementAndChildren(e);
		for(let [e,cbList] of this.pendingOnElementLoaded) if(isElementLoaded(e)){
			for(let cb of cbList) try{ cbList.delete(cb); cb(); }catch(err){ console.error(err); }
			this.pendingOnElementLoaded.delete(e);
		}
	}
	
	// Attrib Handling
	
	/**
	 * Find ScopeDom attributes for an element.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {boolean} [useCache=true] Use cached results
	 * @param {boolean} [checkConnected=true] Check if element is connected
	 * @returns {Map<string,scopeElementAttribDefaults>|null}
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
	 * Find ScopeDom default attributes for an element by traversing up the DOM tree.
	 * 
	 * @param {HTMLElement} element The element to find defaults for
	 * @param {boolean} [useCache=true] Use cached results
	 * @param {boolean} [checkConnected=true] Check if element is connected
	 * @returns {Map<string,scopeElementAttribDefaults>|null} Map of default attribute names to attribute objects
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
	 * Get attribute options with defaults merged in.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The attribute object
	 * @param {boolean} [useCache=true] Use cached results
	 * @param {boolean} [checkConnected=true] Check if element is connected
	 * @returns {Map<string,scopeElementAttribOptionDefaults>} Merged options map
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
	 * Get attribute's value, with fallback to other option values.
	 * 
	 * @param {scopeElementAttribDefaults} attrib The attribute object
	 * @param {Array<string>|Set<string>|null} [whitelist] Whitelist of option keys/names
	 * @param {boolean} [updateOption=true] Update the fallback option 's value to '' (consume)
	 * @param {boolean} [updateAttrib=true] Update attribute with fallback value
	 * @returns {string|null} The fallback value
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
	 * Parse an attribute optionm used mostly by plugins.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {Map<string,scopeElementAttribOptionDefaults>} attribOpts The attribute options map
	 * @param {string} optName The option key/name ($attr:foo-bar becomes 'foo bar')
	 * @param {object|any} [parseOptions] Options for parsing, default (default value), emptyTrue (treat empty as true), runExp (run the expression straight away)
	 * @returns {{value:any, raw:string|null, attribOption:scopeElementAttribOptionDefaults|null, isDefault:boolean}} Parsed option result
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
	 * Create a new scopeElementController for an element.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeBase|object|null} [newScope] The new or existing scopeController
	 * @param {scopeController} [parentScopeCtrl] The parent scopeController
	 * @param {boolean} [insertCache=true] Insert into scopeElementController cache
	 * @returns {scopeElementController} The new scopeElementController
	 */
	elementNewScopeCtrl(element,newScope=void 0,parentScopeCtrl=this.scopeCtrl,insertCache=true){
		if(parentScopeCtrl instanceof scopeElementController) parentScopeCtrl = parentScopeCtrl.ctrl;
		let scopeCtrl = new scopeController(newScope,parentScopeCtrl.eventTarget,parentScopeCtrl,false,this);
		let elementScopeCtrl = new scopeElementController(element,null,scopeCtrl);
		if(insertCache) this.cacheElementScopeCtrls.set(element,elementScopeCtrl);
		return elementScopeCtrl;
	}
	
	/**
	 * Create a new isolated scopeController for an element.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {scopeBase|object|null} [newScope] The new or existing scopeController
	 * @param {scopeController} [parentScopeCtrl] The parent scopeController
	 * @param {boolean} [insertCache=true] Insert into scopeElementController cache
	 * @returns {scopeElementController} The new scopeElementController
	 */
	elementNewIsolatedScopeCtrl(element,newScope=void 0,parentScopeCtrl=this.scopeCtrl,insertCache=true){
		if(parentScopeCtrl instanceof scopeElementController) parentScopeCtrl = parentScopeCtrl.ctrl;
		let scopeCtrl = new scopeController(newScope,null,parentScopeCtrl,true,this);
		let elementScopeCtrl = new scopeElementController(element,null,scopeCtrl);
		if(insertCache) this.cacheElementScopeCtrls.set(element,elementScopeCtrl);
		return elementScopeCtrl;
	}
	
	/**
	 * This creates an alias to a different element, so any scopeElementController lookups on this new element, will return the scopeElementController for the original element.
	 * 
	 * Useful for DOM element swapping ($if:dom for example).
	 * It also aliases element extra scopes & element isolated scopes.
	 * 
	 * @param {HTMLElement} toElement The new element to set alias for
	 * @param {HTMLElement} fromElement The original element to alias from
	 */
	elementScopeSetAlias(toElement,fromElement){
		// Element Scopes
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
	
	/**
	 * Create or re-use scopeElementController for this element.
	 * 
	 * @param {HTMLElement} element The element to create a scopeElementController for
	 * @param {boolean} [useCache=true] Use cached scopeElementController
	 * @param {boolean} [findParent=true] Include parent controller for scopeElementController
	 * @param {scopeBase|object|null} [newScope] Scope passed to scopeElementController
	 * @returns {scopeElementController} The new or existing scopeElementController
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
	 * Find the closest parent scopeElementController for an element.
	 * 
	 * @param {HTMLElement} element The element
	 * @returns {scopeElementController|null} The parent scope controller or null
	 */
	elementFindParentScopeCtrl(element){
		for(let e=element; e; e=e.parentNode){
			if(!this.cacheConnectedNodes.has(e) && element.nodeType!==textNodeType) return;
			if(this.cacheElementScopeCtrls.has(e)) return this.cacheElementScopeCtrls.get(e);
		}
	}
	
	/**
	 * Execute an expression on an element via scopeElementController.
	 * 
	 * @param {scopeElementController} elementScopeCtrl The scopeElementController
	 * @param {string} expression The expression to execute
	 * @param {object|null} [extra=null] Extra scopes (handy for plugins)
	 * @param {object} [options] execExpression options
	 */
	elementExecExp(elementScopeCtrl,expression,extra=null,options={}){
		let extraScopes = extra?[extra]:[], elementScopes = this.getElementScopes(elementScopeCtrl.element);
		let { globalContext, documentContext, signalProxyAll } = this.options;
		options = { __proto__:null, globalsHide:!globalContext, hideDocument:!documentContext, useSignalProxy:!!signalProxyAll, ...options };
		return elementScopeCtrl.execElementExpression(expression,extraScopes,elementScopes,options);
	}
	
	/**
	 * Get all element extra scopes for an element.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {Array<object>} [eScopes] Accumulator array (internal use)
	 * @returns {Array<object>} Array of [element, scopesArray] pairs
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
	 * Resolve element scopes recursively (used by getElementScopes).
	 * 
	 * @param {HTMLElement} key The key/element
	 * @param {HTMLElement|null} [isolated=null] The isolated element
	 * @param {Set<HTMLElement>} [uniqueKeys] Set of unique keys to prevent recursion
	 * @param {Array<object>} [list] Internal accumulator list
	 * @returns {Array<object>} Resolved scopes list
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
	 * Register an event listener to be removed on disconnect.
	 * Any event listeners related to an element, should call this to cleanup after itself.
	 * 
	 * @param {HTMLElement} element The element
	 * @param {Function} removeListener The function to remove the listener
	 */
	registerElementRelatedEvent(element,removeListener){
		let map = this.elementRelatedEventListeners;
		if(!map.has(element)) map.set(element,new Set());
		map.get(element).add(removeListener);
	}
	
	/**
	 * Remove event listeners related to the element.
	 * 
	 * @param {HTMLElement} element The element
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
	 * Gets signal for given key/variable expression. If it doesnt exist, it creates one.
	 * Useful for making sure a variable exists, to be usable elsewhere.
	 * 
	 * @param {Element} element Element for elementScopeController instance
	 * @param {string} key Expression (scope variable name)
	 * @returns {object} { signal, expFn } expFn is an expression function that returns the expression's result.
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
	 * Trigger connect for an element - handles all attribute processing.
	 * 
	 * @param {HTMLElement} element The element being connected
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
	 * Trigger disconnect for an element - handles cleanup.
	 * 
	 * @param {HTMLElement} element The element being disconnected
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
	 * Cleanup disconnected element caches and listeners.
	 * 
	 * @param {WeakKey} element The element to cleanup
	 * @param {boolean} [completely=false] Clear connected nodes cache & pending connect nodes
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
	 * @typedef pluginTemplate
	 * @property {Function} onConnect Callback for when an element is connected
	 * @property {Function} onDisconnect Callback for when an element is disconnected
	 * @property {Function} onPluginAdd Callback for when a plugin is added
	 * @property {Function} onExpression Callback for when an expression is being built
	 */
	
	/**
	 * Add a plugin to this instance.
	 *
	 * Registers a plugin and binds its lifecycle hooks to the plugin system.
	 * If late plugin adding is disabled, an error is thrown.
	 * 
	 * @param {pluginTemplate|Function} plugin Plugin object or constructor function
	 * @throws {Error} If late plugin adding is disabled
	 * @returns {boolean} True if plugin was added successfully
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
	
	/**
	 * Initialize all plugins for this instance.
	 * 
	 * Loads all post-main plugins and registers them with the plugin system.
	 * 
	 * @throws {Error} If late plugin adding is disabled
	 */
	initPlugins(){
		if(this.plugins.init) return;
		if(!this.options.allowLatePlugins) throw console.log(this.options), new Error("ScopeDom: late plugin adding is disabled, due to instance { allowLatePlugins:false }");
		for(let plugin of pluginsPostMain||Object.values(window.ScopeDomPlugins||[])||[]) this.pluginAdd(plugin);
		this.plugins.init=true;
	}
	
	/**
	 * Trigger all onConnect plugin callbacks.
	 * 
	 * Iterates through all registered plugins and executes onConnect with the provided pluginOnElementPlug object.
	 * 
	 * @param {pluginOnElementPlug} plugObj The pluginOnElementPlug object containing element and scope information
	 */
	pluginsOnConnect(plugObj){
		for(let pluginOnConnect of this.plugins.onConnect) try{ pluginOnConnect(plugObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * Trigger all onDisconnect plugin callbacks.
	 * 
	 * Iterates through all registered plugins and executes onDisconnect with the provided pluginOnElementPlug object.
	 * 
	 * @param {pluginOnElementPlug} plugObj The pluginOnElementPlug object containing element and scope information
	 */
	pluginsOnDisconnect(plugObj){
		for(let pluginOnDisconnect of this.plugins.onDisconnect) try{ pluginOnDisconnect(plugObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * Trigger all onPluginAdd plugin callbacks.
	 *
	 * Iterates through all registered plugins and executes onPluginAdd with the provided pluginOnElementPlug object.
	 *
	 * @param {pluginOnElementPlug} plugObj The pluginOnElementPlug object containing element and scope information
	 */
	pluginsOnPluginAdd(plugObj){
		for(let pluginOnPluginAdd of this.plugins.onPluginAdd) try{ pluginOnPluginAdd(plugObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * Trigger all onExpression plugin callbacks.
	 * 
	 * Iterates through all registered plugins and executes onExpression with the provided pluginOnElementExpression object.
	 * 
	 * @param {pluginOnElementExpression} expObj The pluginOnElementExpression object containing expression & scope information
	 */
	pluginsOnElementExpression(expObj){
		for(let pluginOnExpression of this.plugins.onExpression) try{ pluginOnExpression(expObj); }catch(err){ console.error(err); }
	}
	
	/**
	 * Run onConnect for a late-added plugin on existing elements.
	 * 
	 * Recursively processes the DOM tree starting at given element, and executes onConnect with element & all children.
	 * 
	 * @param {{ onConnect:Function }} plugin The plugin with onConnect method
	 * @param {HTMLElement} element The element to run connect on
	 * @param {boolean} [act=true] Run onConnect for this plugin
	 * @param {Set} [list] Internal accumulator list for tracking elements
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

/**
 * Object passed to onConnect, onDisconnect and onPluginAdd for plugins.
 * 
 * This class provides context information to plugin lifecycle callbacks,
 * including the ScopeDom instance, element, scope controller, and ScopeDom attributes.
 * 
 * @class pluginOnElementPlug
 */
class pluginOnElementPlug {
	/**
	 * @constructor
	 * @param {ScopeDom} instance The ScopeDom instance
	 * @param {HTMLElement} element The DOM element
	 * @param {scopeElementController} elementScopeCtrl The scopeElementController for the element
	 * @param {Map<string,scopeElementAttribDefaults>} attribs ScopeDom attributes object
	 */
	constructor(instance,element,elementScopeCtrl,attribs){
		/** @type {ScopeDom} The ScopeDom instance */
		this.instance = instance;
		/** @type {HTMLElement} The DOM element */
		this.element = element;
		/** @type {scopeElementController} The scopeElementController for the element */
		this.elementScopeCtrl = elementScopeCtrl;
		/** @type {Map<string,scopeElementAttribDefaults>} ScopeDom attributes object */
		this.attribs = attribs;
	}
}

/**
 * Object passed to onExpression for plugins.
 * 
 * This class provides context information to plugin expression callbacks,
 * including the ScopeDom instance, element, scope controller, and expression object.
 * 
 * @class pluginOnElementExpression
 */
class pluginOnElementExpression {
	/**
	 * @constructor
	 * @param {ScopeDom} instance The ScopeDom instance
	 * @param {HTMLElement} element The DOM element
	 * @param {scopeElementController} elementScopeCtrl The scopeElementController for the element
	 * @param {object} expObj The ScopeDom expression object
	 * @param {string} expObj.expression Raw expression as a string. Modify this.
	 * @param {Set} expObj.mainScopes List of main scopes to pass into the expression builder
	 * @param {Set} expObj.otherScopes List of other scopes to pass into the expression builder
	 * @param {execExp.execExpOptions|object|null} expObj.options Execution options
	 */
	constructor(instance,element,elementScopeCtrl,expObj){
		/** @type {ScopeDom} The ScopeDom instance */
		this.instance = instance;
		/** @type {HTMLElement} The DOM element */
		this.element = element;
		/** @type {scopeElementController} The scopeElementController for the element */
		this.elementScopeCtrl = elementScopeCtrl;
		/** @type {object} The ScopeDom expression object { expression, mainScopes, otherScopes, options } */
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
