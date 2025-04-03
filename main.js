const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const oracledb = require("oracledb");
require("dotenv").config(); // Cargar variables de entorno
const { diffLines } = require("diff"); // Importamos la librería de comparación

let mainWindow;
let userSession = null; // Guardará la sesión del usuario autenticado

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Maximizar la ventana al iniciar
  mainWindow.maximize();

  mainWindow.loadFile("index.html");
});

ipcMain.on("login-attempt", async (event, credentials) => {
  try {
    // Obtener la cadena de conexión desde .env
    const connectionString = process.env[credentials.selectedConnection];

    if (!connectionString) {
      event.reply("login-response", "Error: Conexión no válida.");
      return;
    }

    // Intentar la conexión con la cadena obtenida
    const connection = await oracledb.getConnection({
      user: credentials.username,
      password: credentials.password,
      connectionString: connectionString,
    });

    // Guardar la sesión del usuario autenticado
    userSession = {
      user: credentials.username,
      password: credentials.password,
      connectionString: connectionString,
    };

    event.reply("login-response", "Conexión exitosa");
    await connection.close();
  } catch (error) {
    event.reply("login-response", `Error: ${error.message}`);
  }
});

// Función para normalizar código oracle (eliminar CREATE OR REPLACE y prefijos de esquema)
function normalizeOracleCode(code, objectType, objectName) {
  // Patrones para detectar y eliminar el encabezado CREATE OR REPLACE
  const patterns = [
    // Para package spec
    new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+(?:\\w+\\.)?${objectName}\\s+`,
      "i"
    ),
    // Para package body
    new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+BODY\\s+(?:\\w+\\.)?${objectName}\\s+`,
      "i"
    ),
    // Para funciones
    new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:\\w+\\.)?${objectName}\\s+`,
      "i"
    ),
    // Para procedimientos
    new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+PROCEDURE\\s+(?:\\w+\\.)?${objectName}\\s+`,
      "i"
    ),
  ];

  // Aplicar cada patrón hasta que uno funcione
  let normalizedCode = code;
  for (const pattern of patterns) {
    if (pattern.test(code)) {
      // Si el patrón coincide, reemplazamos con la versión simplificada correspondiente
      if (
        objectType === "PACKAGE BODY" ||
        /PACKAGE\s+BODY/i.test(pattern.source)
      ) {
        normalizedCode = code.replace(pattern, `PACKAGE BODY ${objectName} `);
      } else if (
        objectType === "PACKAGE" ||
        /PACKAGE(?!\s+BODY)/i.test(pattern.source)
      ) {
        normalizedCode = code.replace(pattern, `PACKAGE ${objectName} `);
      } else if (objectType === "FUNCTION") {
        normalizedCode = code.replace(pattern, `FUNCTION ${objectName} `);
      } else if (objectType === "PROCEDURE") {
        normalizedCode = code.replace(pattern, `PROCEDURE ${objectName} `);
      }
      break;
    }
  }

  return normalizedCode;
}

ipcMain.on(
  "compare-code",
  async (event, { fileContent, schema, objectType, objectName }) => {
    if (!userSession) {
      event.reply("compare-response", "Error: No hay usuario autenticado.");
      return;
    }

    try {
      const connection = await oracledb.getConnection(userSession);

      let dbCode = "";
      let specCode = "";
      let bodyCode = "";

      // Consulta mejorada para extraer PACKAGE y PACKAGE BODY en formato exacto
      if (objectType === "PACKAGE") {
        // Consulta mejorada para extraer el código exactamente como está almacenado
        // La consulta ahora obtiene TEXT directamente en el orden correcto
        let result = await connection.execute(
          `SELECT TYPE, LINE, TEXT
                 FROM ALL_SOURCE 
                 WHERE OWNER = :schema 
                 AND NAME = :objectName 
                 AND TYPE IN ('PACKAGE', 'PACKAGE BODY')
                 ORDER BY TYPE, LINE`,
          { schema, objectName },
          { fetchInfo: { TEXT: { type: oracledb.STRING } } }
        );

        // Organizar el resultado en dos partes: spec y body
        if (result.rows.length > 0) {
          // Separar el código del spec y el body
          let currentType = null;
          let currentCode = [];

          // Procesar cada línea en el orden correcto
          for (const row of result.rows) {
            const type = row[0]; // 'PACKAGE' o 'PACKAGE BODY'
            const text = row[2]; // El texto de la línea

            // Si cambiamos de tipo, guardamos el código anterior
            if (type !== currentType) {
              if (currentType === "PACKAGE") {
                specCode = currentCode.join("");
              } else if (currentType === "PACKAGE BODY") {
                bodyCode = currentCode.join("");
              }
              currentType = type;
              currentCode = [];
            }

            // Añadir esta línea al código actual
            currentCode.push(text);
          }

          // No olvidar guardar el último bloque
          if (currentType === "PACKAGE") {
            specCode = currentCode.join("");
          } else if (currentType === "PACKAGE BODY") {
            bodyCode = currentCode.join("");
          }

          // Combinar el código completo
          if (specCode) {
            dbCode += specCode;
          }

          if (bodyCode) {
            // Concatenar body directamente sin separadores ni saltos adicionales
            dbCode += '/\n';
            dbCode += bodyCode + '/\n';
          }
        }
      } else {
        // Para otros tipos de objetos (no package)
        const result = await connection.execute(
          `SELECT TEXT
                 FROM ALL_SOURCE 
                 WHERE OWNER = :schema 
                 AND NAME = :objectName 
                 AND TYPE = :objectType
                 ORDER BY LINE`,
          { schema, objectName, objectType },
          { fetchInfo: { TEXT: { type: oracledb.STRING } } }
        );

        if (result.rows.length > 0) {
          dbCode = result.rows.map((row) => row[0]).join("");
        }
      }

      // Si no se encuentra código en la base de datos
      if (!dbCode) {
        event.reply(
          "compare-response",
          `Error: No se encontró el objeto ${objectType} ${schema}.${objectName} en la base de datos.`
        );
        await connection.close();
        return;
      }

      // Normalizar encabezados para que sean consistentes antes de comparar
      fileContent = normalizeOracleCode(fileContent, objectType, objectName);

      // Normalizar saltos de línea para consistencia entre diferentes sistemas (Windows, Unix)
      dbCode = dbCode.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      fileContent = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      // Comparar el código de la BD con el archivo usando diff con opciones precisas
      const differences = diffLines(dbCode, fileContent, {
        ignoreWhitespace: false,
        newlineIsToken: true,
      });

      // Verificar si hay diferencias
      const hasDifferences = differences.some(
        (part) => part.added || part.removed
      );

      // Preparar respuesta con toda la información necesaria para la vista lado a lado
      const response = JSON.stringify({
        dbCode,
        fileContent,
        differences,
        hasDifferences,
        specCodePresent: !!specCode,
        bodyCodePresent: !!bodyCode,
      });

      event.reply("compare-response", response);
      await connection.close();
    } catch (error) {
      console.error(error);
      event.reply("compare-response", `Error: ${error.message}`);
    }
  }
);