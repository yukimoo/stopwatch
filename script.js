let timer;
let seconds = 0;
let isRunning = false;

function updateDisplay() {
    let hrs = String(Math.floor(seconds / 3600)).padStart(2, '0');
    let mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    let secs = String(seconds % 60).padStart(2, '0');
    document.getElementById('display').textContent = `${hrs}:${mins}:${secs}`;
}

function start() {
    if (!isRunning) {
        isRunning = true;
        timer = setInterval(() => {
            seconds++;
            updateDisplay();
        }, 1000);
    }
}

function stop() {
    clearInterval(timer);
    isRunning = false;
}

function reset() {
    stop();
    seconds = 0;
    updateDisplay();
}

document.getElementById('startBtn').addEventListener('click', start);
document.getElementById('stopBtn').addEventListener('click', stop);
document.getElementById('resetBtn').addEventListener('click', reset);
