// Importamos los módulos necesarios
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');

// Cargamos los certificados SSL/TLS
const serverOptions = {
  key: fs.readFileSync('../certs/key.pem'),
  cert: fs.readFileSync('../certs/cert.pem')
};

// Creamos un servidor HTTPS con los certificados
const server = https.createServer(serverOptions);

// Creamos un servidor WebSocket sobre el servidor HTTPS
const wss = new WebSocket.Server({ server });

// --- Lógica de Limitación de Tasa ---
const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 5; // Puedes ajustar este valor a tu necesidad

// Manejamos los eventos de conexión de los clientes
wss.on('connection', ws => {
  const ip = ws._socket.remoteAddress;

  // Lógica para verificar el límite de conexiones
  const connectionsCount = ipConnections.get(ip) || 0;
  if (connectionsCount >= MAX_CONNECTIONS_PER_IP) {
    console.log(`❌ Límite de conexiones (${MAX_CONNECTIONS_PER_IP}) excedido para ${ip}. Cerrando conexión.`);
    ws.close(1008, 'Límite de conexiones excedido'); // Código 1008 para indicar Política Violada
    return;
  }

  // Si la conexión es válida, la permitimos y actualizamos el contador
  ipConnections.set(ip, connectionsCount + 1);
  console.log(`✅ Cliente conectado desde ${ip}. Conexiones activas: ${ipConnections.get(ip)}`);

  // Manejamos los mensajes entrantes
  ws.on('message', message => {
    console.log(`Mensaje recibido de ${ip}: ${message}`);
    // Respondemos al cliente
    ws.send(`Echo: ${message}`);
  });

  // Manejamos el cierre de la conexión
  ws.on('close', () => {
    // Al desconectarse, decrementamos el contador de conexiones para esa IP
    const currentConnections = ipConnections.get(ip) - 1;
    if (currentConnections <= 0) {
      ipConnections.delete(ip); // Eliminamos la entrada si ya no hay conexiones activas
    } else {
      ipConnections.set(ip, currentConnections);
    }
    console.log(`Client ${ip} desconectado. Conexiones activas: ${currentConnections > 0 ? currentConnections : 0}`);
  });
});

// Iniciamos el servidor en un puerto específico
const PORT = 8443;
server.listen(PORT, () => {
  console.log(`Servidor WSS iniciado en https://notice.iot-ve.online:${PORT}`);
});