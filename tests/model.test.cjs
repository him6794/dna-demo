const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../simulator-model.js');

function add(model, type, variant) {
    return model.addComponent({ type, ...(type === 'base' ? { base: variant } : type === 'sugar' ? { sugarType: variant || 'deoxyribose' } : {}) });
}

function nucleotide(model, base = 'A', sugarType = 'deoxyribose') {
    const phosphate = add(model, 'phosphate');
    const sugar = add(model, 'sugar', sugarType);
    const nitrogenBase = add(model, 'base', base);
    model.connect(phosphate.id, sugar.id);
    model.connect(sugar.id, nitrogenBase.id);
    return { phosphate, sugar, base: nitrogenBase };
}

test('builds a nucleotide and assigns one edge per bond', () => {
    const model = new Model();
    const dna = nucleotide(model);
    assert.equal(model.components.length, 3);
    assert.deepEqual(model.connections.map(edge => edge.bondType), ['strong-bond', 'weak-bond']);
    assert.deepEqual(new Set(model.getConnectedIds(dna.base.id)), new Set(model.components.map(component => component.id)));
    assert.deepEqual(model.getConnectedIds('missing'), []);
});

test('all supported complementary pairs work in either order', () => {
    for (const [first, second] of [['A', 'T'], ['T', 'A'], ['A', 'U'], ['U', 'A'], ['C', 'G'], ['G', 'C']]) {
        const model = new Model();
        const edge = model.connect(add(model, 'base', first).id, add(model, 'base', second).id);
        assert.equal(edge.bondType, 'hydrogen-bond');
    }
});

test('rejects incorrect pairs, self-bonds, missing endpoints, and reversed duplicates without mutation', () => {
    const model = new Model();
    const a = add(model, 'base', 'A');
    const t = add(model, 'base', 'T');
    const c = add(model, 'base', 'C');
    assert.throws(() => model.connect(a.id, c.id), /配對/);
    assert.throws(() => model.connect(a.id, a.id), /自己/);
    assert.throws(() => model.connect(a.id, 'missing'), /找不到/);
    model.connect(a.id, t.id);
    const snapshot = model.toJSON();
    assert.throws(() => model.connect(t.id, a.id), /已經/);
    assert.deepEqual(model.toJSON(), snapshot);
    assert.equal(model.connectionCounter, 1);
});

test('rejects unsupported chemical bond types in either direction', () => {
    for (const [firstType, secondType] of [['phosphate', 'phosphate'], ['sugar', 'sugar'], ['phosphate', 'base'], ['base', 'phosphate']]) {
        const model = new Model();
        const first = add(model, firstType, firstType === 'base' ? 'A' : undefined);
        const second = add(model, secondType, secondType === 'base' ? 'A' : undefined);
        assert.throws(() => model.connect(first.id, second.id));
        assert.equal(model.connections.length, 0);
    }
});

test('checks DNA/RNA sugar compatibility regardless of connection order', () => {
    for (const [sugarType, base] of [['deoxyribose', 'U'], ['ribose', 'T']]) {
        for (const reverse of [false, true]) {
            const model = new Model();
            const sugar = add(model, 'sugar', sugarType);
            const nitrogenBase = add(model, 'base', base);
            assert.throws(() => model.connect(...(reverse ? [nitrogenBase.id, sugar.id] : [sugar.id, nitrogenBase.id])), /不能連接/);
        }
    }
    for (const [sugarType, bases] of [['deoxyribose', ['A', 'T', 'C', 'G']], ['ribose', ['A', 'U', 'C', 'G']]]) {
        for (const base of bases) assert.doesNotThrow(() => nucleotide(new Model(), base, sugarType));
    }
});

test('limits a sugar and base to one glycosidic bond each', () => {
    const model = new Model();
    const dna = nucleotide(model);
    assert.throws(() => model.connect(dna.sugar.id, add(model, 'base', 'C').id), /每個糖/);
    assert.throws(() => model.connect(dna.base.id, add(model, 'sugar').id), /每個鹼基/);
});

test('limits each base to one complementary partner', () => {
    const model = new Model();
    const a = add(model, 'base', 'A');
    model.connect(a.id, add(model, 'base', 'T').id);
    assert.throws(() => model.connect(add(model, 'base', 'U').id, a.id), /另一個鹼基/);
});

test('supports a two-sided sugar phosphate backbone but prevents branching', () => {
    const model = new Model();
    const sugar = add(model, 'sugar');
    const phosphate = add(model, 'phosphate');
    model.connect(sugar.id, phosphate.id);
    model.connect(sugar.id, add(model, 'phosphate').id);
    model.connect(phosphate.id, add(model, 'sugar').id);
    assert.throws(() => model.connect(sugar.id, add(model, 'phosphate').id), /每個糖最多/);
    assert.throws(() => model.connect(phosphate.id, add(model, 'sugar').id), /每個磷酸基最多/);
});

test('prevents mixed sugar types along a phosphate backbone', () => {
    const model = new Model();
    const phosphate = add(model, 'phosphate');
    model.connect(add(model, 'sugar', 'ribose').id, phosphate.id);
    assert.throws(() => model.connect(add(model, 'sugar', 'deoxyribose').id, phosphate.id), /相同種類/);
});

test('allows DNA/RNA hybrid pairing and intrachain RNA pairing', () => {
    const hybrid = new Model();
    const dna = nucleotide(hybrid, 'A');
    const rna = nucleotide(hybrid, 'U', 'ribose');
    assert.doesNotThrow(() => hybrid.connect(dna.base.id, rna.base.id));

    const hairpin = new Model();
    const a = nucleotide(hairpin, 'A', 'ribose');
    const u = nucleotide(hairpin, 'U', 'ribose');
    hairpin.connect(a.sugar.id, u.phosphate.id);
    assert.doesNotThrow(() => hairpin.connect(a.base.id, u.base.id));
    assert.equal(hairpin.getConnectedIds(a.base.id).length, 6);
});

test('disconnecting a bridge splits the connected groups immediately', () => {
    const model = new Model();
    const first = nucleotide(model);
    const second = nucleotide(model, 'T');
    const bridge = model.connect(first.base.id, second.base.id);
    assert.equal(model.getConnectedIds(first.phosphate.id).length, 6);
    assert.equal(model.disconnect(bridge.id), true);
    assert.equal(model.getConnectedIds(first.phosphate.id).length, 3);
    assert.equal(model.getConnectedIds(second.phosphate.id).length, 3);
    assert.equal(model.disconnect(bridge.id), false);
});

test('deleting a component removes incident edges and leaves detached neighbors usable', () => {
    const model = new Model();
    const dna = nucleotide(model);
    assert.equal(model.removeComponent(dna.sugar.id), true);
    assert.equal(model.connections.length, 0);
    assert.deepEqual(model.getConnectedIds(dna.base.id), [dna.base.id]);
    assert.deepEqual(model.getConnectedIds(dna.phosphate.id), [dna.phosphate.id]);
    assert.equal(model.removeComponent(dna.sugar.id), false);
    const replacement = add(model, 'sugar');
    assert.notEqual(replacement.id, dna.sugar.id);
    assert.doesNotThrow(() => model.connect(replacement.id, dna.base.id));
});

test('disconnecting a component preserves components and other bonds', () => {
    const model = new Model();
    const dna = nucleotide(model);
    assert.equal(model.disconnectComponent(dna.base.id), 1);
    assert.equal(model.components.length, 3);
    assert.equal(model.connections.length, 1);
    assert.equal(model.disconnectComponent(dna.base.id), 0);
    assert.deepEqual(model.getConnectedIds(dna.base.id), [dna.base.id]);
});

test('clear removes all components and bonds and resets IDs', () => {
    const model = new Model();
    nucleotide(model);
    model.clear();
    assert.deepEqual(model.toJSON(), { version: 1, components: [], connections: [] });
    assert.equal(add(model, 'phosphate').id, 'component-0');
    assert.equal(model.connectionCounter, 0);
});

test('serialization creates independent snapshots and round-trips positions, angles, and bonds', () => {
    const model = new Model();
    const dna = nucleotide(model);
    dna.sugar.x = 12.25;
    dna.sugar.y = 400;
    dna.sugar.rotation = 80;
    const snapshot = model.toJSON();
    const restored = Model.fromJSON(JSON.parse(JSON.stringify(snapshot)));
    assert.deepEqual(restored.toJSON(), snapshot);
    restored.components[0].x = 75;
    restored.connections[0].from = 'changed';
    assert.equal(model.components[0].x, 0);
    assert.equal(snapshot.components[0].x, 0);
    assert.equal(snapshot.connections[0].from, dna.phosphate.id);
});

test('restoring reordered and sparse IDs resumes unique counters', () => {
    const model = new Model();
    const dna = nucleotide(model);
    const snapshot = model.toJSON();
    snapshot.components[2].id = 'component-90';
    snapshot.connections[1].to = 'component-90';
    snapshot.connections[0].id = 'connection-50';
    snapshot.connections[1].id = 'connection-3';
    snapshot.components.reverse();
    const restored = Model.fromJSON(snapshot);
    const secondPhosphate = add(restored, 'phosphate');
    assert.equal(secondPhosphate.id, 'component-91');
    assert.equal(restored.connect(secondPhosphate.id, dna.sugar.id).id, 'connection-51');
});

test('rejects malformed components and non-finite coordinates on creation', () => {
    const model = new Model();
    for (const entry of [null, [], { type: 'unknown' }, { type: 'base', base: 'X' }, { type: 'sugar', sugarType: 'unknown' }, { type: 'phosphate', x: NaN }, { type: 'phosphate', y: Infinity }, { type: 'phosphate', rotation: '0' }]) {
        assert.throws(() => model.addComponent(entry));
    }
    assert.equal(model.components.length, 0);
    assert.equal(model.counter, 0);
});

test('bounds world coordinates and normalizes finite rotations', () => {
    const model = new Model();
    const component = model.addComponent({ type: 'phosphate', x: 0, y: Model.MAX_COORDINATE, rotation: -45 });
    assert.equal(component.rotation, 315);
    assert.equal(model.addComponent({ type: 'phosphate', rotation: 765 }).rotation, 45);
    const largeAngle = model.addComponent({ type: 'phosphate', rotation: 1e308 }).rotation;
    assert.ok(largeAngle >= 0 && largeAngle < 360);
    for (const bad of [-1, 10000.001, 1e308]) {
        assert.throws(() => model.addComponent({ type: 'phosphate', x: bad }), /位置必須介於/);
        assert.throws(() => model.addComponent({ type: 'phosphate', y: bad }), /位置必須介於/);
        const snapshot = model.toJSON();
        snapshot.components[0].x = bad;
        assert.throws(() => Model.fromJSON(snapshot), /位置必須介於/);
    }
    const snapshot = model.toJSON();
    snapshot.components[0].rotation = -405;
    assert.equal(Model.fromJSON(snapshot).components[0].rotation, 315);
});

test('handles the largest supported identifiers without unsafe arithmetic or collisions', () => {
    const maximumId = Number.MAX_SAFE_INTEGER - 1;
    const initial = new Model();
    const dna = nucleotide(initial);
    const snapshot = initial.toJSON();
    snapshot.components[0].id = `component-${maximumId}`;
    snapshot.connections[0].from = `component-${maximumId}`;
    snapshot.connections[0].id = `connection-${maximumId}`;
    const restored = Model.fromJSON(snapshot);
    assert.equal(restored.counter, Number.MAX_SAFE_INTEGER);
    assert.equal(restored.connectionCounter, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(restored.toJSON(), snapshot);
    const before = restored.toJSON();
    assert.throws(() => add(restored, 'phosphate'), /識別碼已用盡/);
    restored.disconnect('connection-1');
    assert.throws(() => restored.connect(dna.sugar.id, dna.base.id), /識別碼已用盡/);
    assert.equal(restored.components.length, before.components.length);
    assert.equal(restored.connections.length, before.connections.length - 1);
    restored.clear();
    assert.equal(add(restored, 'phosphate').id, 'component-0');
});

test('rejects invalid file shape, version, component IDs, and coordinates', () => {
    const model = new Model();
    nucleotide(model);
    const invalidFiles = [null, [], {}, { version: 2, components: [], connections: [] }, { version: 1, components: {}, connections: [] }];
    for (const entry of invalidFiles) assert.throws(() => Model.fromJSON(entry));
    const mutations = [
        data => { data.components[0] = null; },
        data => { data.components[1].id = data.components[0].id; },
        data => { data.components[0].id = '__proto__'; },
        data => { data.components[0].id = 'component-01'; },
        data => { data.components[0].id = 'component-9007199254740992'; },
        data => { delete data.components[0].x; },
        data => { data.components[0].y = Infinity; },
        data => { data.components[0].rotation = null; },
        data => { data.components[1].sugarType = 'unknown'; },
        data => { data.components[2].base = 'X'; }
    ];
    for (const mutate of mutations) {
        const data = model.toJSON();
        mutate(data);
        assert.throws(() => Model.fromJSON(data));
    }
});

test('rejects dangling, duplicate, mistyped, and chemically invalid imported bonds', () => {
    const model = new Model();
    nucleotide(model);
    const mutations = [
        data => { data.connections[0] = null; },
        data => { data.connections[0].from = 'missing'; },
        data => { data.connections[0].to = data.connections[0].from; },
        data => { data.connections[1].id = data.connections[0].id; },
        data => { data.connections[0].id = 'bad'; },
        data => { data.connections.push({ ...data.connections[0], id: 'connection-5' }); },
        data => { data.connections[0].bondType = 'hydrogen-bond'; },
        data => { data.components[2].base = 'U'; }
    ];
    for (const mutate of mutations) {
        const data = model.toJSON();
        mutate(data);
        assert.throws(() => Model.fromJSON(data));
    }
});

test('imports only known fields without retaining hostile or arbitrary properties', () => {
    const data = JSON.parse('{"version":1,"components":[{"id":"component-0","type":"phosphate","x":0,"y":0,"rotation":0,"__proto__":{"polluted":true},"element":"<script>"}],"connections":[]}');
    const model = Model.fromJSON(data);
    assert.deepEqual(Object.keys(model.components[0]), ['id', 'type', 'x', 'y', 'rotation']);
    assert.equal({}.polluted, undefined);
});

test('caps creation and imported file sizes', () => {
    const model = new Model();
    for (let index = 0; index < 500; index += 1) add(model, 'phosphate');
    assert.throws(() => add(model, 'phosphate'), /500/);
    assert.equal(Model.fromJSON(model.toJSON()).components.length, 500);
    const excessiveComponents = model.toJSON();
    excessiveComponents.components.push({ ...excessiveComponents.components[0], id: 'component-500' });
    assert.throws(() => Model.fromJSON(excessiveComponents), /過多/);
    assert.throws(() => Model.fromJSON({ version: 1, components: [], connections: Array(1001).fill(null) }), /過多/);
});
