
import * as util from "node:util";
import fs from 'node:fs';

import { defineConfig } from 'rolldown';

let isWatch = process.env.ROLLUP_WATCH==='true' || process.env.npm_lifecycle_event?.indexOf('watch')!==-1;
let isDev = process.env.NODE_ENV!=='production';

let defaults = {
	platform: "browser",
	treeshake: false,
	cache: true,
	input: {},
	output: {
		cleanDir: true,
		format: "iife",
		sourcemap: isDev ? true : 'hidden',
		generatedCode: {
			profilerNames: isDev,
			symbols: isDev,
		},
		strict: true,
		comments: { legal: true },
	},
	watch: !!isWatch,
	transform: {
		target: "es2022",
		sourcemap: true,
		assumptions: {
			noDocumentAll: true,
		},
	}
};
let banner = `/* This project is licensed under the GNU Lesser General Public License v3.0 (LGPL-3.0) - See LICENSE.md & README.md */\n`;
let footer = `\nif(typeof ScopeDom!=='undefined') Object.freeze(ScopeDom);`;

let minifyProd = {
	target: defaults.transform.target,
	dropLabels: ["DEV"],
	unused: false,
	keepNames: { function: false, class: false },
	compress: {
		toplevel: true,
		passes: 3,
		joinVars: true,
		sequences: true,
		dropConsole: true,
		dropDebugger: true,
	},
	mangle: {
		toplevel: true,
		keepNames: { function: false, class: false },
	},
	treeshake: {
		invalidImportSideEffects: false,
	},
	codegen: {
		removeWhitespace: true,
	},
};

let minifyDev = Object.assign(structuredClone(minifyProd),{
	dropLabels: ["PROD"],
	compress: false,
	mangle: false,
	treeshake: false,
	codegen: false,
	// keepNames: { function: true, class: true },
	// compress: Object.assign(structuredClone(minifyProd.compress),{
	// 	dropConsole: false,
	// 	dropDebugger: false,
	// }),
	// mangle: Object.assign(structuredClone(minifyProd.mangle),{
	// 	debug: true,
	// 	keepNames: { function: true, class: true },
	// }),
});

let pluginUMD = { format:"umd", name:"ScopeDomPlugins", extend:true, exports:"named", banner };
let pluginESM = { format:"es", banner };

let files = {
	core: "./src/scopedom.js",
	bundle: "./src/bundle.js",
	plugins: {
		"cloak-simple": "./src/plugins/cloak-simple.js",
		cloak:	"./src/plugins/cloak.js",
		parse:	"./src/plugins/parse.js",
		if:		"./src/plugins/if.js",
		repeat:	"./src/plugins/repeat.js",
		"pipe-expression":	"./src/plugins/pipe-expression.js",
	},
};

let coreUMD = { input:files.core, output:{ file:"./dist/scopedom.umd.cjs", format:"umd", name:"ScopeDom", exports:"default", extend:true, banner, footer } };
let coreESM = { input:files.core, output:{ file:"./dist/scopedom.mjs", format:"es", banner, footer } };

let bundleUMD = { input:files.bundle, output:{ file:"./dist/scopedom.bundle.umd.cjs", format:"umd", name:"ScopeDom", exports:"default", extend:true, banner, footer } };
let bundleESM = { input:files.bundle, output:{ file:"./dist/scopedom.bundle.mjs", format:"es", banner, footer } };

let packageData = { exports:{ "./package.json":"./package.json" } };

let configUMD = [coreUMD];
let configESM = [coreESM];

// package.json exports
packageData.module = coreESM.output.file;
packageData.exports["."] = {
	module: coreESM.output.file,
	import: coreESM.output.file,
	require: coreUMD.output.file,
	default: coreESM.output.file
};
packageData.exports["./bundle"] = {
	module: bundleESM.output.file,
	import: bundleESM.output.file,
	require: bundleUMD.output.file,
	default: bundleESM.output.file
};
packageData.exports["./dist"] = packageData.exports["."];
packageData.exports["./dist/bundle"] = packageData.exports["./bundle"];

// Plugins
for(let [key,value] of Object.entries(files.plugins)){
	let resultUMD, resultESM;
	configUMD.push(resultUMD = { input:value, output:{ file:`./dist/plugins/${key}.umd.cjs`, ...pluginUMD } });
	configESM.push(resultESM = { input:value, output:{ file:`./dist/plugins/${key}.mjs`, ...pluginESM } });
	// package.json exports
	packageData.exports[`./dist/plugins/${key}`] = {
		module: resultESM.output.file,
		import: resultESM.output.file,
		require: resultUMD.output.file,
		default: resultESM.output.file
	};
}

let config = [...configUMD,...configESM,bundleUMD,bundleESM];

for(let fileConfig of config){
	if(fileConfig.output){
		fileConfig.output = Object.assign({},defaults.output,fileConfig.output);
		// fileConfig.output.minify = minifyProd;
	}
}

for(let fileConfig of config){
	if(!fileConfig.output) continue;
	fileConfig.output.minify = isDev ? minifyDev : minifyProd;
	// if(!isDev) fileConfig.output.minify = minifyProd;
}

// Separate dev/prod
// for(let fileConfig of structuredClone(config)){
// 	if(!fileConfig.output) continue;
// 	fileConfig.output.minify = minifyDev;
// 	fileConfig.output.file = fileConfig.output.file.replace("/dist/","/dist/dev/");
// 	config.push(fileConfig);
// }

import packageMain from './package.json' with { type: 'json' };

// package.json exports
if(!isDev) fs.readFile("./package.json",(err,data)=>{
	if(err) return console.error("rollup.config.js: read error:",err);
	else if(data){
		let packageMain = JSON.parse(data);
		if(!packageMain) return console.error("rollup.config.js: Failed to parse package.json");
		packageMain.main = packageMain.unpkg = packageMain.jsdelivr = coreUMD.output.file;
		packageMain.exports = packageData.exports;
		if(Object.keys(packageData.exports).length===0) return console.error("rollup.config.js: Empty exports");
		fs.writeFile("./package.json",JSON.stringify(packageMain,null,2), err => {
			if(err) return console.error("rollup.config.js: write error:",err);
			else console.log("rollup.config.js: package.json updated");
			console.log("exports:",util.inspect(packageData.exports,{showHidden:false,depth:null,colors:true}));
		});
	}
});

export default defineConfig(config);
