# ScopeDom

**ScopeDom is a Reactive DOM Orchestrator.**

Most modern frameworks attempt to manage the DOM by creating a complex, virtual representation of it. **ScopeDom does the opposite: It makes the DOM itself intelligent.**

By leveraging native Web APIs — specifically Proxies, WeakMaps and MutationObservers — ScopeDom turns standard HTML attributes into **reactive, scoped expressions**. It doesn't try to replace the browser; **it orchestrates it**.

---
### **🚀 The Core Philosophy**

- **DOM as Source of Truth**: No Virtual DOM. If it's in your HTML, it's part of your application state.

- **Zero-Build Architecture**: Write plain JavaScript and standard HTML. There is no compiler, no transpiler, and no build step. It works the moment you load the script.

- **Declarative Reactivity**: Transform static markup into dynamic interfaces using intuitive attributes (eg: `$on-click`, `$if`, `$repeat`) and template syntax (eg: `{{count}}`).

- **Hierarchical Scoping**: Variables and methods flow naturally through the DOM tree, mimicking the way developers already think about nested UI components.

---
### **⚡ Quick Start**

```html
<!-- The data-scopedom-init attribute auto-activates the engine -->
<script src="scopedom.js" data-scopedom-init></script>

<div $scope="{ count: 0 }">
	<p>Count is: {{count}}</p>
	<button $on-click="count++">Increment</button>
</div>
```

**Note:** Replace scopedom.js with the actual path to the script.

---
### **🛠 Project Status**

| Feature | Status |
| :--- | :--- |
| **Core Engine** | 🧪 Experimental / PoC |
| **Plugins** | 🧪 Experimental |
| **Production Ready** | ❌ No |
| **Commercial Use** | ⚠️ Not Recommended |
| **Hobbyist Use** | ✅ Yes, Enjoy! |
| **Unit Tests** | 🚧 In Progress |
| **Version** | ⚠️ Alpha |

*ScopeDom is currently in an experimental / proof-of-concept stage. It is intended for research and hobbyist use and is not yet ready for production environments.*

_Pronounced similarly to "Kingdom"_

---
### 🤝 Contribution

To submit a contribution, please create an issue or a pull request on the [GitHub repository][github-url].

**Note:** Please ensure you run all existing tests after making any changes. All help — from code to documentation improvements — is greatly appreciated!

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
