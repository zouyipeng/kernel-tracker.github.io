@echo off
cd /d D:\zouyipeng\kernel-tracker.github.io
git rm --cached auto-commit.bat
del auto-commit.bat 2>nul
git add .
git commit -m "chore: remove auto-commit.bat"
git push
