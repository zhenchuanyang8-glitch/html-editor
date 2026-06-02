// content/modules-loader.js - 模块加载器
// 动态加载各个功能模块

(function() {
    'use strict';

    // 模块列表
    const modules = [
        'modules/table-resizer.js',
        'modules/shape-tool.js',
        'modules/connector.js'
    ];

    // 加载单个模块
    function loadModule(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL(src);
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    // 加载所有模块
    async function loadAllModules() {
        for (const module of modules) {
            try {
                await loadModule(module);
                console.log(`Module loaded: ${module}`);
            } catch (error) {
                console.error(`Failed to load module: ${module}`, error);
            }
        }
    }

    // 导出加载函数
    window.__loadEditorModules = loadAllModules;

    console.log('Modules loader initialized');
})();
