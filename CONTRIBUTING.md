# Contributing to x402-proxy

Thank you for your interest in contributing to x402-proxy! This document provides guidelines and instructions for contributing to this CLI + MCP proxy that enables automatic payments for any x402 or MPP endpoint.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Contributing Workflow](#contributing-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Security](#security)
- [Community](#community)

## Code of Conduct

This project adheres to a code of conduct that all contributors are expected to follow:

- Be respectful and inclusive in all interactions
- Provide constructive feedback and accept it gracefully
- Focus on what's best for the agentic commerce ecosystem
- Show empathy towards other contributors and users

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or higher)
- **npm** or **yarn**
- **Git**
- **TypeScript** knowledge
- **MetaMask** or similar Web3 wallet
- **Base Sepolia testnet ETH** (for testing)
- **USDC on Base Sepolia** (for payment testing)

### Understanding x402

Before contributing, familiarize yourself with:

- **x402 Protocol**: HTTP 402 Payment Required standard for machine payments
- **MPP (Machine Payments Protocol)**: Cross-chain payment standard
- **MCP (Model Context Protocol)**: Protocol for AI agent tool integration

Resources:
- [x402 Specification](https://x402.org)
- [Coinbase x402](https://github.com/coinbase/x402)
- [MCP Documentation](https://modelcontextprotocol.io)

### Quick Start

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/x402-proxy.git
   cd x402-proxy
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Set up environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

## Development Setup

### Local Development

```bash
# Build the project
npm run build

# Run in development mode
npm run dev

# Run linter
npm run lint

# Run type checker
npm run typecheck
```

### Testing x402 Payments

1. **Start a local x402 server** (for testing):
   ```bash
   npm run test:server
   ```

2. **Test the proxy**:
   ```bash
   npm run test:proxy
   ```

3. **Test MCP integration**:
   ```bash
   npm run test:mcp
   ```

### Chain Support

The proxy supports multiple chains:
- **Base** (primary)
- **Base Sepolia** (testnet)
- **Solana**
- **Tempo**

Test on all supported chains when making changes.

## Project Structure

```
x402-proxy/
├── src/               # Source code
│   ├── cli/          # CLI implementation
│   │   ├── index.ts       # CLI entry point
│   │   ├── commands/      # CLI commands
│   │   └── utils/         # CLI utilities
│   ├── mcp/          # MCP proxy implementation
│   │   ├── server.ts      # MCP server
│   │   ├── tools/         # MCP tools
│   │   └── handlers/      # Request handlers
│   ├── x402/         # x402 protocol implementation
│   │   ├── client.ts      # x402 client
│   │   ├── payment.ts     # Payment handling
│   │   └── verify.ts      # Payment verification
│   └── utils/        # Shared utilities
│       ├── chains.ts      # Chain configurations
│       ├── crypto.ts      # Cryptographic functions
│       └── errors.ts      # Error handling
├── test/             # Test files
│   ├── unit/         # Unit tests
│   ├── integration/  # Integration tests
│   └── fixtures/     # Test fixtures
├── scripts/          # Build and utility scripts
└── docs/             # Documentation
```

## Contributing Workflow

### 1. Create an Issue

Before starting work:

- Check existing issues to avoid duplicates
- Create a new issue describing your proposed change
- Wait for maintainer feedback on significant changes

### 2. Branch Naming

Create branches with descriptive names:

```
feature/add-solana-support
fix/mcp-tool-handling
docs/update-chain-config
refactor/payment-flow
```

### 3. Commit Messages

Follow conventional commits format:

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting)
- `refactor`: Code refactoring
- `test`: Test additions/changes
- `chore`: Build process or auxiliary tool changes

Examples:
```
feat(mcp): add support for custom headers

Allow users to pass custom headers to x402 endpoints
through MCP tool configuration.

Closes #123
```

### 4. Pull Request Process

1. **Ensure tests pass**:
   ```bash
   npm test
   npm run lint
   npm run typecheck
   ```

2. **Update documentation** if needed

3. **Create PR** with:
   - Clear title and description
   - Reference to related issue(s)
   - Test results
   - Example usage (for new features)

4. **Address review feedback** promptly

5. **Wait for approval** from at least one maintainer

## Coding Standards

### TypeScript

- Use strict TypeScript configuration
- Follow ESLint configuration
- Document all public functions with JSDoc
- Use explicit types (avoid `any`)

```typescript
/**
 * Processes an x402 payment request
 * @param request - The payment request details
 * @param config - Chain and wallet configuration
 * @returns Promise resolving to payment result
 */
async function processPayment(
  request: PaymentRequest,
  config: ChainConfig
): Promise<PaymentResult> {
  // Implementation
}
```

### Error Handling

- Use custom error classes
- Provide meaningful error messages
- Include error codes for programmatic handling

```typescript
class X402Error extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'X402Error';
  }
}
```

### Chain Configuration

Support new chains by adding to `src/utils/chains.ts`:

```typescript
export const chainConfigs: Record<string, ChainConfig> = {
  base: {
    rpcUrl: 'https://mainnet.base.org',
    chainId: 8453,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    // ...
  },
  // Add new chains here
};
```

## Testing

### Unit Tests

Write comprehensive unit tests:

```typescript
describe('Payment Processing', () => {
  it('should process valid payment request', async () => {
    const request = createMockRequest();
    const result = await processPayment(request, baseConfig);
    expect(result.success).toBe(true);
  });
});
```

### Integration Tests

Test end-to-end flows:

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- payment.test.ts
```

### Manual Testing

Test against real endpoints:

```bash
# Test with a real x402 endpoint
x402-proxy curl https://api.example.com/paid-endpoint

# Test MCP server
x402-proxy mcp --config ./mcp-config.json
```

## Security

### Reporting Vulnerabilities

**DO NOT** open public issues for security vulnerabilities.

Instead:
1. Email security concerns to: security@cascade-protocol.xyz
2. Include detailed description and reproduction steps
3. Allow 48 hours for initial response
4. Coordinate disclosure timeline

### Security Best Practices

When contributing:

- **Never commit private keys** or sensitive data
- **Use environment variables** for configuration
- **Validate all inputs** from external sources
- **Use constant-time comparison** for cryptographic operations
- **Follow OWASP guidelines** for CLI security
- **Get security review** for payment-related changes

### Payment Security

- Verify all payment signatures
- Validate chain IDs
- Check token contract addresses
- Implement proper nonce handling
- Use secure random number generation

## Community

### Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General questions and ideas
- **Discord**: [Join our community](https://discord.gg/cascade-protocol)
- **Twitter**: [@CascadeProtocol](https://twitter.com/CascadeProtocol)

### Getting Help

- Check [documentation](https://docs.cascade-protocol.xyz)
- Search existing issues
- Ask in Discord #dev-help channel
- Tag maintainers in PRs if stuck

### Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Mentioned in release notes
- Eligible for bounty programs
- Considered for core team roles

## Bounty Program

We offer bounties for:

- **Critical security bugs**: $5,000 - $10,000
- **New chain support**: $1,000 - $3,000
- **High impact features**: $500 - $2,000
- **Documentation improvements**: $100 - $500
- **Bug fixes**: $50 - $200

Check [active bounties](https://github.com/cascade-protocol/x402-proxy/issues?q=is%3Aopen+label%3Abounty) for opportunities.

## Resources

### Learning

- [x402 Protocol Specification](https://x402.org)
- [Coinbase x402 Implementation](https://github.com/coinbase/x402)
- [MCP Documentation](https://modelcontextprotocol.io)
- [Base Documentation](https://docs.base.org)

### Tools

- [Foundry](https://book.getfoundry.sh/) - Ethereum development toolkit
- [Viem](https://viem.sh/) - Ethereum library
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - MCP debugging

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping build the future of agentic commerce! 🚀