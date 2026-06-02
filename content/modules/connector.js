// content/modules/connector.js - 连接线工具模块

(function() {
    'use strict';

    // 防止重复加载
    if (window.__ConnectorLoaded__) {
        return;
    }
    window.__ConnectorLoaded__ = true;

    class ConnectorTool {
        constructor() {
            this.connectors = [];
            this.drawing = false;
            this.startElement = null;
            this.tempLine = null;
            this.overlay = null;
            this.init();
        }

        init() {
            // 创建SVG覆盖层
            this.createOverlay();

            // 监听连接模式事件
            document.addEventListener('click', this.handleClick.bind(this));
            document.addEventListener('mousemove', this.handleMouseMove.bind(this));
            document.addEventListener('keydown', this.handleKeyDown.bind(this));
        }

        createOverlay() {
            this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            this.overlay.setAttribute('class', 'html-connector-overlay');
            this.overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 9998;
            `;
            document.body.appendChild(this.overlay);
        }

        handleClick(e) {
            if (!document.body.classList.contains('connector-mode')) {
                return;
            }

            const target = e.target;
            const connectable = target.closest('.html-editable, .html-editable-table, .html-editable-image, .html-shape');

            if (!connectable) {
                this.cancelDrawing();
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (!this.startElement) {
                // 开始连接
                this.startElement = connectable;
                this.startPoint = this.getElementCenter(connectable);
                this.createTempLine(this.startPoint, this.startPoint);

                // 高亮起始元素
                connectable.classList.add('connector-start');
            } else {
                // 完成连接
                this.endElement = connectable;
                this.endPoint = this.getElementCenter(connectable);

                if (this.startElement !== this.endElement) {
                    this.createConnector(this.startElement, this.endElement);
                }

                this.cancelDrawing();
            }
        }

        handleMouseMove(e) {
            if (!this.drawing || !this.tempLine) return;

            const currentPoint = { x: e.clientX, y: e.clientY };
            this.updateTempLine(this.startPoint, currentPoint);
        }

        handleKeyDown(e) {
            if (e.key === 'Escape') {
                this.cancelDrawing();
            }
        }

        getElementCenter(element) {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        }

        createTempLine(start, end) {
            this.drawing = true;

            this.tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            this.tempLine.setAttribute('x1', start.x);
            this.tempLine.setAttribute('y1', start.y);
            this.tempLine.setAttribute('x2', end.x);
            this.tempLine.setAttribute('y2', end.y);
            this.tempLine.setAttribute('stroke', '#e74c3c');
            this.tempLine.setAttribute('stroke-width', '2');
            this.tempLine.setAttribute('stroke-dasharray', '5,5');
            this.tempLine.style.pointerEvents = 'none';

            this.overlay.appendChild(this.tempLine);
        }

        updateTempLine(start, end) {
            if (!this.tempLine) return;
            this.tempLine.setAttribute('x2', end.x);
            this.tempLine.setAttribute('y2', end.y);
        }

        createConnector(startEl, endEl) {
            const start = this.getElementCenter(startEl);
            const end = this.getElementCenter(endEl);

            // 创建连接线组
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('class', 'html-connector');

            // 创建路径（贝塞尔曲线）
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const d = this.calculatePath(start, end);
            path.setAttribute('d', d);
            path.setAttribute('stroke', '#3498db');
            path.setAttribute('stroke-width', '2');
            path.setAttribute('fill', 'none');
            path.setAttribute('class', 'connector-line');

            // 创建箭头标记
            const arrowId = 'arrowhead-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            marker.setAttribute('id', arrowId);
            marker.setAttribute('markerWidth', '10');
            marker.setAttribute('markerHeight', '10');
            marker.setAttribute('refX', '9');
            marker.setAttribute('refY', '3');
            marker.setAttribute('orient', 'auto');

            const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            polygon.setAttribute('points', '0 0, 10 3, 0 6');
            polygon.setAttribute('fill', '#3498db');

            marker.appendChild(polygon);
            defs.appendChild(marker);
            group.appendChild(defs);

            // 设置箭头
            path.setAttribute('marker-end', 'url(#' + arrowId + ')');

            // 添加交互
            path.style.cursor = 'pointer';
            path.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('删除此连接线？')) {
                    group.remove();
                }
            });

            group.appendChild(path);
            this.overlay.appendChild(group);

            // 保存连接信息
            this.connectors.push({
                start: startEl,
                end: endEl,
                element: group
            });

            // 添加元素标记
            startEl.classList.add('connector-source');
            endEl.classList.add('connector-target');

            // 保存到元素数据
            if (!startEl.dataset.connectors) startEl.dataset.connectors = '{}';
            if (!endEl.dataset.connectors) endEl.dataset.connectors = '{}';

            const startConnectors = JSON.parse(startEl.dataset.connectors);
            const endConnectors = JSON.parse(endEl.dataset.connectors);

            const connectorId = 'connector-' + Date.now();
            startConnectors[connectorId] = { type: 'source', target: endEl };
            endConnectors[connectorId] = { type: 'target', source: startEl };

            startEl.dataset.connectors = JSON.stringify(startConnectors);
            endEl.dataset.connectors = JSON.stringify(endConnectors);
        }

        calculatePath(start, end) {
            // 计算贝塞尔曲线路径
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // 控制点偏移量
            const offset = Math.min(distance * 0.5, 100);

            // 根据方向选择控制点
            let cp1, cp2;

            if (Math.abs(dx) > Math.abs(dy)) {
                // 水平方向为主
                cp1 = { x: start.x + offset, y: start.y };
                cp2 = { x: end.x - offset, y: end.y };
            } else {
                // 垂直方向为主
                cp1 = { x: start.x, y: start.y + offset };
                cp2 = { x: end.x, y: end.y - offset };
            }

            return `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
        }

        cancelDrawing() {
            this.drawing = false;

            if (this.tempLine) {
                this.tempLine.remove();
                this.tempLine = null;
            }

            if (this.startElement) {
                this.startElement.classList.remove('connector-start');
                this.startElement = null;
            }

            this.endElement = null;
        }

        // 更新所有连接线（当元素移动时调用）
        updateConnectors() {
            this.connectors.forEach(connector => {
                const start = this.getElementCenter(connector.start);
                const end = this.getElementCenter(connector.end);
                const path = connector.element.querySelector('.connector-line');

                if (path) {
                    const d = this.calculatePath(start, end);
                    path.setAttribute('d', d);
                }
            });
        }

        // 清除所有连接线
        clearAll() {
            this.connectors.forEach(connector => {
                connector.element.remove();
            });
            this.connectors = [];

            document.querySelectorAll('.connector-source, .connector-target').forEach(el => {
                el.classList.remove('connector-source', 'connector-target');
                delete el.dataset.connectors;
            });
        }

        // 删除特定元素的所有连接
        disconnectElement(element) {
            const connectors = element.dataset.connectors;
            if (!connectors) return;

            const data = JSON.parse(connectors);

            Object.keys(data).forEach(id => {
                const info = data[id];
                const otherElement = info.type === 'source' ? info.target : info.source;

                // 删除连接线
                const connectorIndex = this.connectors.findIndex(c =>
                    (c.start === element && c.end === otherElement) ||
                    (c.start === otherElement && c.end === element)
                );

                if (connectorIndex !== -1) {
                    this.connectors[connectorIndex].element.remove();
                    this.connectors.splice(connectorIndex, 1);
                }

                // 清除其他元素的引用
                if (otherElement && otherElement.dataset && otherElement.dataset.connectors) {
                    const otherData = JSON.parse(otherElement.dataset.connectors);
                    delete otherData[id];
                    otherElement.dataset.connectors = JSON.stringify(otherData);
                }
            });

            // 清除元素标记
            element.classList.remove('connector-source', 'connector-target');
            delete element.dataset.connectors;
        }

        // 导出连接线数据
        exportData() {
            return this.connectors.map(connector => ({
                start: this.getElementSelector(connector.start),
                end: this.getElementSelector(connector.end)
            }));
        }

        // 获取元素选择器（用于序列化）
        getElementSelector(element) {
            // 简化版本：使用索引
            const parent = element.parentNode;
            if (!parent) return '';

            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(element);

            return `${element.tagName.toLowerCase()}:nth-child(${index + 1})`;
        }
    }

    // 导出
    window.__ConnectorTool = ConnectorTool;

    // 全局实例
    window.__connectorTool = new ConnectorTool();

    // 监听元素移动，更新连接线
    const observer = new MutationObserver(() => {
        if (window.__connectorTool) {
            window.__connectorTool.updateConnectors();
        }
    });

    observer.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['style']
    });

    console.log('Connector Tool module loaded');
})();
