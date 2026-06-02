// content/modules/shape-tool.js - 形状工具模块

(function() {
    'use strict';

    // 防止重复加载
    if (window.__ShapeToolLoaded__) {
        return;
    }
    window.__ShapeToolLoaded__ = true;

    class ShapeTool {
        constructor() {
            this.shapes = [];
            this.activeShape = null;
            this.dragState = null;
            this.init();
        }

        init() {
            // 监听形状点击
            document.addEventListener('mousedown', this.handleShapeMouseDown.bind(this));
            document.addEventListener('mousemove', this.handleShapeMouseMove.bind(this));
            document.addEventListener('mouseup', this.handleShapeMouseUp.bind(this));
        }

        handleShapeMouseDown(e) {
            const shape = e.target.closest('.html-shape');
            if (!shape) return;

            e.preventDefault();
            e.stopPropagation();

            this.activeShape = shape;
            const rect = shape.getBoundingClientRect();

            this.dragState = {
                shape: shape,
                startX: e.clientX,
                startY: e.clientY,
                originalX: rect.left,
                originalY: rect.top,
                originalWidth: rect.width,
                originalHeight: rect.height
            };

            shape.classList.add('shape-dragging');
            document.body.style.cursor = 'move';
            document.body.style.userSelect = 'none';
        }

        handleShapeMouseMove(e) {
            if (!this.dragState) return;

            const { shape, startX, startY, originalX, originalY } = this.dragState;
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            // 计算新位置（相对于父元素）
            const parentRect = shape.offsetParent.getBoundingClientRect();
            const newLeft = originalX - parentRect.left + deltaX;
            const newTop = originalY - parentRect.top + deltaY;

            shape.style.position = 'relative';
            shape.style.left = newLeft + 'px';
            shape.style.top = newTop + 'px';
        }

        handleShapeMouseUp(e) {
            if (!this.dragState) return;

            const { shape } = this.dragState;
            shape.classList.remove('shape-dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            this.dragState = null;
            this.activeShape = null;
        }

        // 插入形状
        insertShape(type, options = {}) {
            const shape = this.createShape(type, options);
            this.insertAtCursor(shape);
            return shape;
        }

        createShape(type, options = {}) {
            const colors = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];
            const color = options.color || colors[Math.floor(Math.random() * colors.length)];
            const width = options.width || 150;
            const height = options.height || 100;

            let shapeHTML = '';

            switch (type) {
                case 'rect':
                    shapeHTML = `<div class="html-shape html-shape-rect" contenteditable="false"
                        style="width:${width}px;height:${height}px;background:${color};margin:10px 0;"></div>`;
                    break;

                case 'circle':
                    const size = Math.min(width, height);
                    shapeHTML = `<div class="html-shape html-shape-circle" contenteditable="false"
                        style="width:${size}px;height:${size}px;background:${color};border-radius:50%;margin:10px 0;"></div>`;
                    break;

                case 'rounded-rect':
                    shapeHTML = `<div class="html-shape html-shape-rounded" contenteditable="false"
                        style="width:${width}px;height:${height}px;background:${color};border-radius:12px;margin:10px 0;"></div>`;
                    break;

                case 'diamond':
                    shapeHTML = `<div class="html-shape html-shape-diamond" contenteditable="false"
                        style="width:${width}px;height:${height}px;background:${color};margin:10px 0;
                        transform:rotate(45deg);margin:20px;"></div>`;
                    break;

                case 'arrow':
                    shapeHTML = `<div class="html-shape html-shape-arrow" contenteditable="false" style="margin:10px 0;">
                        <svg width="${width}" height="50" viewBox="0 0 ${width} 50">
                            <defs>
                                <marker id="arrowhead-${Date.now()}" markerWidth="10" markerHeight="10"
                                    refX="9" refY="3" orient="auto">
                                    <polygon points="0 0, 10 3, 0 6" fill="${color}" />
                                </marker>
                            </defs>
                            <line x1="0" y1="25" x2="${width - 10}" y2="25" stroke="${color}"
                                stroke-width="3" marker-end="url(#arrowhead-${Date.now()})"/>
                        </svg>
                    </div>`;
                    break;

                case 'triangle':
                    shapeHTML = `<div class="html-shape html-shape-triangle" contenteditable="false" style="margin:10px 0;">
                        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                            <polygon points="${width/2},0 ${width},${height} 0,${height}" fill="${color}"/>
                        </svg>
                    </div>`;
                    break;

                case 'star':
                    shapeHTML = `<div class="html-shape html-shape-star" contenteditable="false" style="margin:10px 0;">
                        <svg width="${Math.max(width, height)}" height="${Math.max(width, height)}" viewBox="0 0 100 100">
                            <polygon points="50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35"
                                fill="${color}"/>
                        </svg>
                    </div>`;
                    break;

                case 'hexagon':
                    shapeHTML = `<div class="html-shape html-shape-hexagon" contenteditable="false" style="margin:10px 0;">
                        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                            <polygon points="${width*0.25},0 ${width*0.75},0 ${width},${height*0.5}
                                ${width*0.75},${height} ${width*0.25},${height} 0,${height*0.5}" fill="${color}"/>
                        </svg>
                    </div>`;
                    break;

                case 'parallelogram':
                    shapeHTML = `<div class="html-shape html-shape-parallelogram" contenteditable="false"
                        style="width:${width}px;height:${height}px;background:${color};margin:10px 0;
                        transform:skewX(-20deg);"></div>`;
                    break;

                default:
                    return null;
            }

            return shapeHTML;
        }

        insertAtCursor(html) {
            const selection = window.getSelection();
            if (!selection.rangeCount) {
                document.body.insertAdjacentHTML('beforeend', html);
                return;
            }

            const range = selection.getRangeAt(0);
            range.deleteContents();

            const fragment = range.createContextualFragment(html);
            range.insertNode(fragment);

            // 移动光标
            range.setStartAfter(fragment.lastChild || fragment);
            range.setEndAfter(fragment.lastChild || fragment);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        // 更改形状颜色
        changeShapeColor(shape, color) {
            if (!shape || !shape.classList.contains('html-shape')) return;

            if (shape.tagName === 'DIV' && shape.style.background) {
                shape.style.background = color;
            } else if (shape.tagName === 'DIV' && shape.querySelector('svg')) {
                const svg = shape.querySelector('svg');
                const polygon = svg.querySelector('polygon');
                const line = svg.querySelector('line');
                const marker = svg.querySelector('marker polygon');

                if (polygon) polygon.setAttribute('fill', color);
                if (line) line.setAttribute('stroke', color);
                if (marker) marker.setAttribute('fill', color);
            }
        }

        // 删除形状
        deleteShape(shape) {
            if (!shape || !shape.classList.contains('html-shape')) return;
            shape.remove();
        }

        // 复制形状
        duplicateShape(shape) {
            if (!shape || !shape.classList.contains('html-shape')) return;
            const clone = shape.cloneNode(true);
            shape.parentNode.insertBefore(clone, shape.nextSibling);
            return clone;
        }
    }

    // 导出
    window.__ShapeTool = ShapeTool;

    // 全局实例
    window.__shapeTool = new ShapeTool();

    console.log('Shape Tool module loaded');
})();
