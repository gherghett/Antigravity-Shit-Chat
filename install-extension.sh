#!/bin/bash

# Get the absolute path of the extension directory
EXT_PATH="$(pwd)/extension"
TARGET_PATH="$HOME/.antigravity/extensions/shitchat-antigravity"

# Check if extension directory exists
if [ ! -d "$EXT_PATH" ]; then
    echo "❌ Error: Could not find 'extension' directory. Run this from the project root."
    exit 1
fi

# Create extensions dir if not exists
mkdir -p "$HOME/.antigravity/extensions"

# Remove existing symlink if it exists
if [ -L "$TARGET_PATH" ]; then
    rm "$TARGET_PATH"
fi

# Create symlink
ln -s "$EXT_PATH" "$TARGET_PATH"

echo "✅ Extension installed to $TARGET_PATH"
echo "♻️  Please restart Antigravity to activate it."
