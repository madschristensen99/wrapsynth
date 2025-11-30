# Circom Hello World

A basic Circom project with two simple circuits demonstrating zero-knowledge proof construction.

## 📦 Installation

```bash
# Dependencies already installed via package.json
npm install

# Circom compiler (already downloaded as ./circom)
```

## 🏗️ Project Structure

```
├── circuits/           # Circom circuits
│   ├── multiplier.circom     # Simple multiplication circuit
│   └── range_proof.circom    # Range proof circuit
├── inputs/            # Test input files
│   ├── multiplier.json
│   └── range_proof.json
├── test/              # Test scripts
│   └── test.js
├── circom             # Circom compiler binary
└── package.json
```

## 🚀 Quick Start

### Compile circuits:
```bash
npm run compile
```

### Run tests:
```bash
npm test
```

### Clean generated files:
```bash
npm run clean
```

## 🔍 Circuits

### 1. Multiplier Circuit (`multiplier.circom`)
A simple circuit that takes two inputs and outputs their product.

**Inputs:**
- `a`: First number
- `b`: Second number

**Output:**
- `c`: Product of a and b

### 2. Simple Range Circuit (`simple_range.circom`)
A basic numerical range constraint.

**Inputs:**
- `value`: Number to check

**Output:**
- `yes`: The value (shows how signals flow)

## 🧪 Testing

The test script (`test/test.js`) performs basic validation:
- Multiplication circuits
- Range validation logic
- Input validation

## 📚 Next Steps

1. Generate powers of tau ceremony files
2. Create trusted setups for circuits
3. Generate actual proofs
4. Verify proofs in JavaScript
5. Explore more complex circuits

## 📖 Resources

- [Circom documentation](https://docs.circom.io/)
- [Snarkjs documentation](https://github.com/iden3/snarkjs)
- [Circomlib circuits](https://github.com/iden3/circomlib)