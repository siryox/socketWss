// src/Logger.js
const moment = require('moment');

class Logger {
    static log(level, message, data = {}) {
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
        const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

        // Determina si hay datos adicionales para imprimir
        const logArgs = data && Object.keys(data).length > 0 ? [formattedMessage, data] : [formattedMessage];

        switch (level) {
            case 'info':
                console.log(...logArgs);
                break;
            case 'warn':
                console.warn(...logArgs);
                break;
            case 'error':
                console.error(...logArgs);
                break;
            default:
                console.log(...logArgs);
        }
    }

    static info(message, data) {
        this.log('info', message, data);
    }

    static warn(message, data) {
        this.log('warn', message, data);
    }

    static error(message, data) {
        this.log('error', message, data);
    }
}

module.exports = Logger;