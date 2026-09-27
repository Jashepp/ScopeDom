# ScopeDom

**ScopeDom is a Reactive DOM Orchestrator.**

No Virtual DOM. No build step. Standard HTML attributes (`$on-click`, `$if`, `$repeat`) and text interpolation `{{expression}}` become reactive through native Web APIs via Proxies, WeakMaps, and MutationObservers.

---
### ⚡ The Core Philosophy

- **The DOM is the Source of Truth** - No Virtual DOM layer. Your HTML is your application state.
- **No Build Step** - Plain JavaScript and HTML. No compiler. No transpiler. No bundler configuration.
- **Declarative Reactivity** - Expressions on real HTML elements and text. `$on-click`, `$if`, `$repeat`, `{{value}}`.
- **Hierarchical Scopes** - `$scope` declares variable boundaries that walk up the DOM tree. Child elements inherit from their parent.
- **Immediate Observation** - MutationObserver sees the elements as the DOM streams in. No DOMContentLoaded wait for functionality.

_Pronounced similarly to "Kingdom"_

---
### ✨ Key Features

- **Deep Reactivity** - Objects, Arrays, Maps, and Sets become reactive automatically. Infinite proxy depth, with WeakRefs preventing memory leaks.
- **Hierarchical Scoping** - Scope variables and methods cascade down the DOM tree. Both the `$scope` attribute and plugins create scoped contexts that child elements inherit from.
- **Zero Build** - Plain HTML + JS. No compiler, no transpiler. Works from a single `<script>` tag or import.
- **Plugin System** - Injectable behaviour and custom attributes, with existing pre-made plugins: `$cloak`, `$parse`, `$if`, `$repeat`

---
### 🚀 Quick Start

```html
<!-- The data-scopedom-init attribute auto-activates the engine -->
<script src="scopedom.umd.js" data-scopedom-init></script>
<!-- Optional: Enable {{expression}} syntax via the parse plugin -->
<script src="parse.umd.js"></script>

<!-- The $scope attribute defines encapsulated scope variables -->
<div $scope="{ count: 0 }">
	<!-- Use $parse:text to enable interpolation within text nodes -->
	<p $parse:text>Count is: {{count}}</p>
	<!-- Increment count on click event -->
	<button $on-click="count++">Increment</button>
</div>
```

WIP

---
### 📋 Documentation & Guides
*Find everything you need to master ScopeDom:*

WIP

---
### 🛠 Project Status

| Feature | Status |
| :--- | :--- |
| **Core Engine** | 🧪 Experimental / PoC |
| **Core Plugins** | 🧪 Experimental |
| **Commercial Use** | ❌ Not Ready |
| **Hobbyist Use** | 🧪 Experimental |
| **Unit Tests** | 🚧 In Progress |

*ScopeDom is currently in an experimental / proof-of-concept stage. It is intended for research and hobbyist use and is not yet ready for production environments.*

---
### 📦 Functionality & Plugins

#### Signal Reactivity

- Infinite proxy depth - chained/nested values get their own `signalProxy` with WeakRef references.
- Method wrappers (`push`, `pop`, `splice`) trigger updates on mutation.
- Disable auto-proxification: `ScopeDom.init({ signalProxyAll: false })` (`signalProxyAll=true` by default).
- Controller-level optional signal management even without `signalProxy`.
- **Auto-Reactive:** `cart.push({ name:'Milk', qty:2 });` - reactivity fires automatically. Most standard prototypes are wrapped to auto-trigger signal reads & changes.
- **Deep Nesting:** `settings.user.pref.theme = 'light';` - The entire chain automatically uses `signalProxy`, no declarations per level. Every nested access creates its own signal on demand, so deeply nested objects get full reactivity with a single call.

#### Expressions

- Designed to run with context of Scopes & Elements:
	- `$scope`, `$scopeParent`, `$scopeTop` helper variables
	- `$this`, `$parent`, `$previous`, `$next` - DOM Elements & Navigation
	- `$event` on EventTarget listeners
	- Can return values, such as `{{expression}}` & `<div $if="count===1">`
- Helper Methods:
	- `$("#nav")` (document), `$$(".title")` (element) - query selectors
	- `$on`, `$off`, `$emit` - event registry for scopes & elements with native EventTarget

#### Scope Hierarchy

- Access variables directly, or as properties on scope helpers `$scope`, `$scopeParent`, `$scopeTop`.
- Variable lookups travel up the DOM tree:
```html
<!-- Child scope inherits `user`+`ready` from parent, then defines local `firstName` -->
<div $scope="{ user:{ name:'Alice Johnson' }, ready:true }">
	<span $scope="{ firstName:user.name.split(' ')[0] }" $parse:text>{{firstName}}: {{ready?'Ready':''}}</span>
</div>
```

#### Performance

- Helper methods to queue computation tasks & render tasks.
- All DOM edits are done via `requestAnimationFrame`.
- All DOM references use `WeakMap` / `WeakSet` / `WeakRef`.

#### Plugins

- `$cloak` - CSS cloak with anchor comment swapping, reducing/eliminating FOUC (Flash of Unstyled Content).
- `$parse` - Text interpolation `{{expression}}` and attribute binding.
- `$if` - Conditional rendering with match-case and sibling chains.
- `$repeat` - Data-driven element repetition/listing with identity-based DOM reconciliation & `moveBefore`.
- `pipeExp` - Expression pipes `{{ item.price | $fmt.currency:'USD' }}` live transformed to `{{ $fmt.currency(item.price,'USD') }}`.
- Simple plugin hooks - `onConnect`, `onDisconnect`, `onPluginAdd`, `onExpression`.

---
### 🤝 Contribution

To submit a contribution, please create an issue or a pull request on the [GitHub repository][github-url].

**Note:** Please ensure you run all existing tests after making any changes. All help, from code to documentation improvements, is greatly appreciated!

---
### ⚖️ License

Copyright (c) 2026 Jason Sheppard [@Jashepp](https://github.com/Jashepp).

*All rights reserved. Licensing will transition to an open-source model once the project reaches a stable milestone.*

---
### 🔗 Links

**Github Repository**: [https://github.com/Jashepp/ScopeDom][github-url]

[github-url]: https://github.com/Jashepp/ScopeDom
[github-releases]: https://github.com/Jashepp/ScopeDom/releases
[github-tags]: https://github.com/Jashepp/ScopeDom/tags
