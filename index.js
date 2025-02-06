const { app, BrowserWindow } = require('electron');
const { execSync } = require('child_process');
const express = require('express');
const expressapp = express();

function parseVideoFormats(output) {
    const lines = output.split('\n').filter(line =>
        !line.includes('[') &&
        !line.includes(']') &&
        !line.includes('Downloading') &&
        !line.includes('Available formats') &&
        !line.includes('ID') &&
        !line.includes('-------------------') &&
        line.trim()
    );

    const result = lines.map(line => {
        let parts = line.split(/\s{2,}/).map(part => part.trim());
        parts = parts.flatMap(part => part.split('|').map(subPart =>
            subPart.trim()).filter(subPart => subPart));
        const firstPart = parts[0].split(' ').map(subPart => subPart.trim());
        parts[0] = firstPart[0];
        parts.splice(1, 0, firstPart[1] || '');
        parts.splice(2, 0, firstPart.slice(2).join(' ') || '');
        parts = parts.flatMap(part => part.split(' ').map(subPart =>
            subPart.trim()));
        parts = parts.filter(value => value && value !== 'unknown' && value
            !== 'Original');
        for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === "video" && parts[i + 1] === "only") {
                parts[i] = "video only";
                parts.splice(i + 1, 1);
                break;
            }
            if (parts[i] === "audio" && parts[i + 1] === "only") {
                parts[i] = "audio only";
                parts.splice(i + 1, 1);
                break;
            }
        }
        if (parts.includes("audio only") && parts.indexOf("audio only") !==
            parts.lastIndexOf("audio only")) {
            parts = parts.filter((value, index) => value !== "audio only" ||
                index === parts.indexOf("audio only"));
        }
        return parts;
    }).filter(parts => parts.length > 1);

    const uniqueResult = Array.from(new Set(result.map(a =>
        JSON.stringify(a))))
        .map(e => JSON.parse(e));

    const finalResult = uniqueResult.map(item => Array.from(new Set(item)));

    return finalResult;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true
        }
    });

    win.loadURL(`file://${__dirname}/web/index.html?port=${serverPort}`);
    win.on('closed', () => {
        app.quit();
    });
}

function createListWindow() {
    const win = new BrowserWindow({
        width: 450,
        height: 600,
        webPreferences: {
            nodeIntegration: true
        }
    });

    win.loadURL(`file://${__dirname}/web/supported.html`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

let serverPort;
const server = expressapp.listen(0, () => {
    serverPort = server.address().port;
    console.log(`Server is running on port ${serverPort}`);
});

expressapp.get('/get_vid_options', (req, res) => {
    try {
        const output = execSync('./yt-dlp -F "https://vimeo.com/312498320"',
            { encoding: 'utf8' });
        const parsedOutput = parseVideoFormats(output);
        console.log(parsedOutput);
        res.send(parsedOutput);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching video options');
    }
});

expressapp.get('/show_supported_list', (req, res) => {
    createListWindow()
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
