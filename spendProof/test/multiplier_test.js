const {wasm} = require("circom_tester");
const path = require("path");

describe("Multiplier Circuit Test", function () {
    let circuit;

    this.beforeAll(async () => {
        circuit = await wasm(path.join(__dirname, "../circuits/multiplier.circom"));
    });

    it("should multiply 2 * 3 = 6", async () => {
        const input = {a: 2, b: 3};
        const witness = await circuit.calculateWitness(input);
        await circuit.assertOut(witness, {c: 6});
    });

    it("should multiply 5 * 7 = 35", async () => {
        const input = {a: 5, b: 7};
        const witness = await circuit.calculateWitness(input);
        await circuit.assertOut(witness, {c: 35});
    });

    it("should handle edge case 0 * 10 = 0", async () => {
        const input = {a: 0, b: 10};
        const witness = await circuit.calculateWitness(input);
        await circuit.assertOut(witness, {c: 0});
    });
});