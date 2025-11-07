#!/bin/bash
# Pre-commit setup script for Happy CLI
# This script installs and configures pre-commit hooks

set -e

echo "🚀 Setting up pre-commit hooks for Happy CLI..."

# Check if pre-commit is installed
if ! command -v pre-commit &> /dev/null; then
    echo "❌ pre-commit not found. Installing..."

    # Try pip3 first
    if command -v pip3 &> /dev/null; then
        echo "📦 Installing with pip3..."
        pip3 install --user pre-commit
    # Try pip
    elif command -v pip &> /dev/null; then
        echo "📦 Installing with pip..."
        pip install --user pre-commit
    # Try brew
    elif command -v brew &> /dev/null; then
        echo "📦 Installing with brew..."
        brew install pre-commit
    else
        echo "❌ No package manager found. Please install pre-commit manually:"
        echo "   pip3 install pre-commit"
        exit 1
    fi
fi

# Check if .git directory exists
if [ ! -d ".git" ]; then
    echo "⚠️  Not a git repository. Initializing git..."
    git init
fi

# Install pre-commit hooks
echo "🔧 Installing pre-commit hooks..."
pre-commit install
pre-commit install --hook-type commit-msg

# Run pre-commit on all files to set up the environment
echo "🔍 Running initial pre-commit check on all files..."
if pre-commit run --all-files; then
    echo "✅ Pre-commit setup complete!"
else
    echo "⚠️  Some files need formatting. Run 'yarn format' to fix them."
fi

echo ""
echo "🎉 Pre-commit hooks are now active!"
echo ""
echo "Available commands:"
echo "  yarn format         - Format all files"
echo "  yarn lint           - Run ESLint"
echo "  yarn lint:fix       - Auto-fix ESLint issues"
echo "  yarn lint:types     - TypeScript type checking"
echo "  yarn pre-commit     - Run all pre-commit checks"
echo ""
echo "For more information, see DEVELOPMENT.md"
