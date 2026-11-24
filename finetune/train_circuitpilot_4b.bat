@echo off
rem ============================================================================================
rem  CircuitPilot-4B: everything on a fresh Windows 11 PC with one NVIDIA GPU (tested for 24 GB)
rem
rem  1. installs Python 3.12, Git, Node.js and Ollama (winget)
rem  2. gets CircuitPilot from GitHub and the Python packages (CUDA PyTorch, PEFT, Triton ...)
rem  3. downloads Qwen3.5-4B (9 GB) and makes the training data with CircuitPilot's engine
rem  4. trains (LoRA; 4-bit QLoRA automatically on GPUs under 20 GB)
rem  5. merges, converts to GGUF, quantizes to Q4_K_M and registers "circuitpilot-4b" in Ollama
rem  6. runs the CircuitPilot PCB Bench on it (3 runs) and writes the results
rem
rem  Needs: Windows 11, an NVIDIA driver (nvidia-smi works), ~45 GB free disk, internet.
rem  Run it again any time: finished steps are skipped and training continues where it stopped.
rem ============================================================================================
setlocal EnableExtensions EnableDelayedExpansion

rem ---- settings ------------------------------------------------------------------------------
set EXAMPLES=2880
set EPOCHS=1
set LR=1.5e-4
set BENCH_RUNS=3
set REPO=https://github.com/Abdelhayali/CircuitPilot.git
set WORK=%~dp0CircuitPilot
rem --------------------------------------------------------------------------------------------

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
title CircuitPilot-4B training

echo.
echo === 0. checks ===
where nvidia-smi >nul 2>&1 || (echo No NVIDIA driver found: install the driver for your GPU from nvidia.com, then run this again. & goto :fail)
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
where winget >nul 2>&1 || (echo winget is missing: install "App Installer" from the Microsoft Store, then run this again. & goto :fail)

echo.
echo === 1. tools: Python 3.12, Git, Node.js, Ollama ===
call :find_tools
if not defined PY  winget install -e --id Python.Python.3.12 --scope user --silent --accept-source-agreements --accept-package-agreements
if not defined GIT winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements
if not defined NODE winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
if not defined OLLAMA winget install -e --id Ollama.Ollama --silent --accept-source-agreements --accept-package-agreements
call :find_tools
if not defined PY (echo Python was not found after installing it. Close this window and run the file again. & goto :fail)
if not defined GIT (echo Git was not found after installing it. Close this window and run the file again. & goto :fail)
if not defined NODE (echo Node.js was not found after installing it. Close this window and run the file again. & goto :fail)
if not defined OLLAMA (echo Ollama was not found after installing it. Close this window and run the file again. & goto :fail)
echo Python: %PY%
echo Git:    %GIT%
echo Node:   %NODE%
echo Ollama: %OLLAMA%

echo.
echo === 2. CircuitPilot source ===
if exist "%WORK%\.git" (
  "%GIT%" -C "%WORK%" pull --ff-only || echo [could not update the source - using the copy already here]
) else (
  "%GIT%" clone --depth 1 %REPO% "%WORK%" || goto :fail
)
cd /d "%WORK%" || goto :fail
rem llama.cpp converter at the version whose GGUF layout Ollama loads (newer ones merge Qwen3.5 tensors Ollama does not know yet)
if not exist finetune\tools-llama.cpp-ollama\convert_hf_to_gguf.py (
  "%GIT%" clone --filter=blob:none https://github.com/ggml-org/llama.cpp finetune\tools-llama.cpp-ollama || goto :fail
  "%GIT%" -C finetune\tools-llama.cpp-ollama checkout -q 1a0b56ce || goto :fail
)

echo.
echo === 3. Python packages (one time, ~4 GB) ===
set VPY=%WORK%\finetune\.venv\Scripts\python.exe
if not exist "%VPY%" "%PY%" -m venv finetune\.venv || goto :fail
if not exist finetune\.venv\packages.ok (
  "%VPY%" -m pip install -q --upgrade pip
  "%VPY%" -m pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cu126 || goto :fail
  "%VPY%" -m pip install transformers==5.24.0 peft==0.22.0 accelerate==1.13.0 bitsandbytes==0.50.2 "triton-windows==3.5.1.post24" flash-linear-attention==0.6.0 huggingface_hub==1.33.0 safetensors==0.8.0 sentencepiece==0.2.1 protobuf einops numpy || goto :fail
  "%VPY%" -m pip install -q -e finetune\tools-llama.cpp-ollama\gguf-py || goto :fail
  "%VPY%" -c "import torch; assert torch.cuda.is_available(), 'CUDA not available'; print('GPU for training:', torch.cuda.get_device_name(0))" || goto :fail
  echo ok> finetune\.venv\packages.ok
)

echo.
echo === 4. base model Qwen3.5-4B (9 GB, one time) ===
if not exist finetune\models\Qwen3.5-4B\config.json (
  "%VPY%" -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3.5-4B', local_dir='finetune/models/Qwen3.5-4B')" || goto :fail
)

echo.
echo === 5. training data (made by running CircuitPilot's engine; ~10-20 min) ===
if not exist finetune\data\train.jsonl (
  set /a W=%NUMBER_OF_PROCESSORS%
  if !W! GTR 24 set W=24
  "%NODE%" finetune\make_dataset.mjs --n 3000 --workers !W! || goto :fail
)

echo.
echo === 6. training (many hours: the console shows each step; you can stop and run this file again) ===
if not exist finetune\out\cp4b\lora\adapter_config.json (
  "%VPY%" finetune\train.py --resume --limit %EXAMPLES% --epochs %EPOCHS% --accum 16 --lr %LR% --eval_every 25 --out finetune\out\cp4b || goto :fail
)

echo.
echo === 7. export: merge, GGUF, Q4_K_M, Ollama model "circuitpilot-4b" ===
call :ollama_up
if not exist finetune\out\export\circuitpilot-4b-Q4_K_M.gguf (
  "%VPY%" finetune\export_model.py --lora finetune\out\cp4b\lora --out finetune\out\export --llama_cpp finetune\tools-llama.cpp-ollama --ollama "%OLLAMA%" || goto :fail
)

echo.
echo === 8. CircuitPilot PCB Bench (%BENCH_RUNS% runs of 14 tasks) ===
"%NODE%" bench\pcb_bench.mjs --base http://localhost:11434/v1 --model circuitpilot-4b --label CircuitPilot-4B --repeat %BENCH_RUNS% || goto :fail

echo.
echo ============================================================================================
echo  DONE.
echo   Model in Ollama:  circuitpilot-4b   (CircuitPilot: Use your own API, http://localhost:11434/v1)
echo   GGUF file:        %WORK%\finetune\out\export\circuitpilot-4b-Q4_K_M.gguf
echo   Adapter (LoRA):   %WORK%\finetune\out\cp4b\lora
echo   Bench results:    %WORK%\bench\results\CircuitPilot-4B__compact.json  and  LEADERBOARD.md
echo  Copy the GGUF and the bench results file back to the main PC (or send them to Claude).
echo ============================================================================================
pause
exit /b 0

rem ---- helpers -------------------------------------------------------------------------------
:find_tools
set PY=& set GIT=& set NODE=& set OLLAMA=
for %%P in ("%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%ProgramFiles%\Python312\python.exe") do if exist %%P if not defined PY set PY=%%~P
for %%P in ("%ProgramFiles%\Git\cmd\git.exe" "%LOCALAPPDATA%\Programs\Git\cmd\git.exe") do if exist %%P if not defined GIT set GIT=%%~P
for %%P in ("%ProgramFiles%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe") do if exist %%P if not defined NODE set NODE=%%~P
for %%P in ("%LOCALAPPDATA%\Programs\Ollama\ollama.exe" "%ProgramFiles%\Ollama\ollama.exe") do if exist %%P if not defined OLLAMA set OLLAMA=%%~P
exit /b 0

:ollama_up
"%OLLAMA%" list >nul 2>&1 && exit /b 0
echo starting Ollama ...
start "Ollama" /min "%OLLAMA%" serve
timeout /t 8 /nobreak >nul
"%OLLAMA%" list >nul 2>&1 || (echo Ollama did not start. & exit /b 1)
exit /b 0

:fail
echo.
echo *** Stopped because of the error above. Fix it and run this file again: finished steps are skipped. ***
pause
exit /b 1
