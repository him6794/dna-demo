/* A DOM-free model shared by the browser and Node's regression tests. */
(function (root) {
    'use strict';

    const MAX_COMPONENTS = 500;
    const MAX_CONNECTIONS = 1000;
    const MAX_COORDINATE = 10000;
    const BASES = ['A', 'T', 'C', 'G', 'U'];
    const SUGARS = ['deoxyribose', 'ribose'];
    const PAIRS = { A: ['T', 'U'], T: ['A'], U: ['A'], C: ['G'], G: ['C'] };

    function requireCondition(condition, message) {
        if (!condition) throw new Error(message);
    }

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    }

    function identifierNumber(id, prefix) {
        requireCondition(typeof id === 'string' && new RegExp(`^${prefix}-(0|[1-9][0-9]*)$`).test(id), '檔案中的識別碼無效。');
        const number = Number(id.slice(prefix.length + 1));
        requireCondition(Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER, '檔案中的識別碼過大。');
        return number;
    }

    function componentData(data, id) {
        requireCondition(isRecord(data), '組件資料無效。');
        requireCondition(['phosphate', 'sugar', 'base'].includes(data.type), '未知的組件類型。');
        const component = { id, type: data.type };
        if (data.type === 'base') {
            requireCondition(BASES.includes(data.base), '未知的含氮鹼基。');
            component.base = data.base;
        }
        if (data.type === 'sugar') {
            requireCondition(SUGARS.includes(data.sugarType), '未知的五碳糖。');
            component.sugarType = data.sugarType;
        }
        for (const key of ['x', 'y', 'rotation']) {
            const value = data[key] === undefined ? 0 : data[key];
            requireCondition(typeof value === 'number' && Number.isFinite(value), '組件的位置與角度必須是有限數字。');
            if (key === 'rotation') {
                component[key] = ((value % 360) + 360) % 360;
            } else {
                requireCondition(value >= 0 && value <= MAX_COORDINATE, `組件位置必須介於 0 與 ${MAX_COORDINATE} 之間。`);
                component[key] = value;
            }
        }
        return component;
    }

    class NucleotideModel {
        static MAX_COORDINATE = MAX_COORDINATE;

        constructor() {
            this.components = [];
            this.connections = [];
            this.counter = 0;
            this.connectionCounter = 0;
        }

        addComponent(data) {
            requireCondition(this.components.length < MAX_COMPONENTS, `最多可加入 ${MAX_COMPONENTS} 個組件。`);
            requireCondition(Number.isSafeInteger(this.counter) && this.counter < Number.MAX_SAFE_INTEGER, '組件識別碼已用盡。');
            const component = componentData(data, `component-${this.counter}`);
            this.counter += 1;
            this.components.push(component);
            return component;
        }

        getComponent(id) {
            return this.components.find(component => component.id === id);
        }

        getNeighbors(id) {
            return this.connections
                .filter(connection => connection.from === id || connection.to === id)
                .map(connection => this.getComponent(connection.from === id ? connection.to : connection.from));
        }

        connect(firstId, secondId) {
            const first = this.getComponent(firstId);
            const second = this.getComponent(secondId);
            requireCondition(first && second, '找不到要連接的組件。');
            requireCondition(first !== second, '組件不能連接自己。');
            requireCondition(!this.connections.some(connection =>
                (connection.from === firstId && connection.to === secondId)
                || (connection.from === secondId && connection.to === firstId)), '這兩個組件已經連線。');
            requireCondition(this.connections.length < MAX_CONNECTIONS, `最多可建立 ${MAX_CONNECTIONS} 條連線。`);

            const bondType = this.validateBond(first, second);
            requireCondition(Number.isSafeInteger(this.connectionCounter) && this.connectionCounter < Number.MAX_SAFE_INTEGER, '連線識別碼已用盡。');
            const connection = { id: `connection-${this.connectionCounter}`, from: firstId, to: secondId, bondType };
            this.connectionCounter += 1;
            this.connections.push(connection);
            return connection;
        }

        validateBond(first, second) {
            const neighborsOf = component => this.getNeighbors(component.id);
            const count = (component, type) => neighborsOf(component).filter(neighbor => neighbor.type === type).length;

            if (first.type === 'base' && second.type === 'base') {
                requireCondition(PAIRS[first.base].includes(second.base), '鹼基只能配對 A–T、A–U 或 C–G。');
                requireCondition(count(first, 'base') === 0 && count(second, 'base') === 0, '每個鹼基只能與另一個鹼基配對。');
                // RNA can fold back on itself; DNA/RNA hybrid pairing is also allowed.
                return 'hydrogen-bond';
            }

            const phosphate = first.type === 'phosphate' ? first : second.type === 'phosphate' ? second : null;
            const sugar = first.type === 'sugar' ? first : second.type === 'sugar' ? second : null;
            const base = first.type === 'base' ? first : second.type === 'base' ? second : null;

            if (phosphate && sugar) {
                requireCondition(count(phosphate, 'sugar') < 2, '每個磷酸基最多連接兩個糖。');
                requireCondition(count(sugar, 'phosphate') < 2, '每個糖最多連接兩個磷酸基。');
                requireCondition(neighborsOf(phosphate).every(neighbor => neighbor.sugarType === sugar.sugarType), '同一條糖磷酸骨架請使用相同種類的糖。');
                return 'strong-bond';
            }

            if (sugar && base) {
                requireCondition(count(sugar, 'base') === 0, '每個糖只能連接一個鹼基。');
                requireCondition(count(base, 'sugar') === 0, '每個鹼基只能連接一個糖。');
                requireCondition(!(sugar.sugarType === 'deoxyribose' && base.base === 'U'), 'DNA 的去氧核糖不能連接 U，請改用 T。');
                requireCondition(!(sugar.sugarType === 'ribose' && base.base === 'T'), 'RNA 的核糖不能連接 T，請改用 U。');
                return 'weak-bond';
            }

            throw new Error('請連接磷酸基與糖、糖與鹼基，或兩個互補鹼基。');
        }

        disconnect(connectionId) {
            const oldLength = this.connections.length;
            this.connections = this.connections.filter(connection => connection.id !== connectionId);
            return oldLength !== this.connections.length;
        }

        disconnectComponent(componentId) {
            const oldLength = this.connections.length;
            this.connections = this.connections.filter(connection => connection.from !== componentId && connection.to !== componentId);
            return oldLength - this.connections.length;
        }

        removeComponent(componentId) {
            this.disconnectComponent(componentId);
            const oldLength = this.components.length;
            this.components = this.components.filter(component => component.id !== componentId);
            return oldLength !== this.components.length;
        }

        getConnectedIds(componentId) {
            if (!this.getComponent(componentId)) return [];
            const adjacency = new Map(this.components.map(component => [component.id, []]));
            for (const connection of this.connections) {
                adjacency.get(connection.from).push(connection.to);
                adjacency.get(connection.to).push(connection.from);
            }
            const visited = new Set([componentId]);
            const queue = [componentId];
            for (let index = 0; index < queue.length; index += 1) {
                for (const neighbor of adjacency.get(queue[index])) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        queue.push(neighbor);
                    }
                }
            }
            return queue;
        }

        clear() {
            this.components = [];
            this.connections = [];
            this.counter = 0;
            this.connectionCounter = 0;
        }

        toJSON() {
            return {
                version: 1,
                components: this.components.map(component => ({ ...component })),
                connections: this.connections.map(connection => ({ ...connection }))
            };
        }

        static fromJSON(data) {
            requireCondition(isRecord(data) && data.version === 1, '不支援的檔案格式或版本。');
            requireCondition(Array.isArray(data.components) && Array.isArray(data.connections), '檔案缺少組件或連線資料。');
            requireCondition(data.components.length <= MAX_COMPONENTS && data.connections.length <= MAX_CONNECTIONS, '檔案中的組件或連線過多。');
            const model = new NucleotideModel();
            const componentIds = new Set();

            for (const entry of data.components) {
                requireCondition(isRecord(entry), '組件資料無效。');
                const number = identifierNumber(entry.id, 'component');
                requireCondition(!componentIds.has(entry.id), '檔案含有重複的組件識別碼。');
                for (const key of ['x', 'y', 'rotation']) {
                    requireCondition(Object.hasOwn(entry, key), '檔案缺少組件位置或角度。');
                }
                const component = componentData(entry, entry.id);
                componentIds.add(component.id);
                model.components.push(component);
                model.counter = Math.max(model.counter, number + 1);
            }

            const connectionIds = new Set();
            let nextConnectionId = 0;
            for (const entry of data.connections) {
                requireCondition(isRecord(entry), '連線資料無效。');
                const number = identifierNumber(entry.id, 'connection');
                requireCondition(!connectionIds.has(entry.id), '檔案含有重複的連線識別碼。');
                const connection = model.connect(entry.from, entry.to);
                requireCondition(entry.bondType === connection.bondType, '連線類型與組件不符。');
                connection.id = entry.id;
                connectionIds.add(entry.id);
                nextConnectionId = Math.max(nextConnectionId, number + 1);
            }
            model.connectionCounter = nextConnectionId;
            return model;
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = NucleotideModel;
    else root.NucleotideModel = NucleotideModel;
})(typeof globalThis === 'undefined' ? this : globalThis);
