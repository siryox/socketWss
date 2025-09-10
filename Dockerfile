# Usamos una imagen base de Node.js
# La versión 20-alpine es ligera y segura
FROM node:20-alpine

# Establecemos el directorio de trabajo dentro del contenedor
WORKDIR /opt/socketwss

# Copiamos los archivos de package.json y package-lock.json
# Esto permite a Docker aprovechar la caché de capas si solo cambian los archivos de código
COPY package*.json ./

# Instalamos las dependencias del proyecto
RUN npm install

# Copiamos el resto de los archivos del proyecto (incluido el directorio 'src' y 'certs')
COPY . .

# Exponemos el puerto que el servidor Node.js usará
EXPOSE 8080

# Comando para iniciar la aplicación cuando se ejecute el contenedor
CMD ["npm","run","dev"]