#!/bin/sh
# Script para forçar update do código no container

echo "🔄 Forçando update do código..."

cd /app || exit 1

echo "📥 Fazendo git pull..."
git fetch origin main
git reset --hard origin/main
git pull origin main

echo "📦 Instalando dependências..."
npm install

echo "🔄 Reiniciando PM2..."
pm2 restart all

echo "✅ Update concluído!"
echo "🌍 Versão atual:"
git log --oneline -1
