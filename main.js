const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const oracledb = require("oracledb");
require("dotenv").config(); // Cargar variables de entorno
const { diffLines } = require("diff"); // Importamos la librería de comparación
const fs = require("fs");

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

function normalizeOracleCode(code, objectType, objectName) {
  // Clonar el código original
  let normalizedCode = code;

  // PASO 1: Normalizar encabezados con "CREATE OR REPLACE" (mayúsculas/minúsculas)
  // Caso especial para PACKAGE BODY (tratar primero para evitar confusión con PACKAGE)
  if (objectType === "PACKAGE BODY") {
    // Patrón más amplio para capturar todas las variantes (mayúsculas, minúsculas, con schema)
    normalizedCode = normalizedCode.replace(
      /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+BODY\s+(?:\w+\.)?(\w+)/gi,
      `PACKAGE BODY ${objectName}`
    );
  }
  // Caso para PACKAGE
  else if (objectType === "PACKAGE") {
    normalizedCode = normalizedCode.replace(
      /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+(?:\w+\.)?(\w+)/gi,
      `PACKAGE ${objectName}`
    );
  }
  // Caso para FUNCTION
  else if (objectType === "FUNCTION") {
    normalizedCode = normalizedCode.replace(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:\w+\.)?(\w+)/gi,
      `FUNCTION ${objectName}`
    );
  }
  // Caso para PROCEDURE
  else if (objectType === "PROCEDURE") {
    normalizedCode = normalizedCode.replace(
      /CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+(?:\w+\.)?(\w+)/gi,
      `PROCEDURE ${objectName}`
    );
  }

  // PASO 2: Normalizar encabezados sin "CREATE OR REPLACE" pero con posible schema
  // Verificar si todavía hay referencias al esquema
  if (objectType === "PACKAGE BODY") {
    normalizedCode = normalizedCode.replace(
      /PACKAGE\s+BODY\s+(?:\w+\.)?(\w+)/gi,
      `PACKAGE BODY ${objectName}`
    );
  } else if (objectType === "PACKAGE") {
    normalizedCode = normalizedCode.replace(
      /PACKAGE\s+(?:\w+\.)?(\w+)/gi,
      `PACKAGE ${objectName}`
    );
  } else if (objectType === "FUNCTION") {
    normalizedCode = normalizedCode.replace(
      /FUNCTION\s+(?:\w+\.)?(\w+)/gi,
      `FUNCTION ${objectName}`
    );
  } else if (objectType === "PROCEDURE") {
    normalizedCode = normalizedCode.replace(
      /PROCEDURE\s+(?:\w+\.)?(\w+)/gi,
      `PROCEDURE ${objectName}`
    );
  }

  // PASO 3: Normalizar encabezados en minúsculas que pudieron escapar
  if (
    normalizedCode.includes("create or replace") ||
    normalizedCode.includes("CREATE OR REPLACE")
  ) {
    // Para package body
    if (objectType === "PACKAGE BODY") {
      normalizedCode = normalizedCode.replace(
        /create\s+or\s+replace\s+package\s+body\s+(?:\w+\.)?(\w+)/i,
        `PACKAGE BODY ${objectName}`
      );
    }
    // Para package spec
    else if (objectType === "PACKAGE") {
      normalizedCode = normalizedCode.replace(
        /create\s+or\s+replace\s+package\s+(?:\w+\.)?(\w+)/i,
        `PACKAGE ${objectName}`
      );
    }
    // Para function
    else if (objectType === "FUNCTION") {
      normalizedCode = normalizedCode.replace(
        /create\s+or\s+replace\s+function\s+(?:\w+\.)?(\w+)/i,
        `FUNCTION ${objectName}`
      );
    }
    // Para procedure
    else if (objectType === "PROCEDURE") {
      normalizedCode = normalizedCode.replace(
        /create\s+or\s+replace\s+procedure\s+(?:\w+\.)?(\w+)/i,
        `PROCEDURE ${objectName}`
      );
    }
  }

  // PASO 4: Asegurar que keywords estén en MAYÚSCULAS
  normalizedCode = normalizedCode.replace(
    /\bpackage\s+body\b/gi,
    "PACKAGE BODY"
  );
  normalizedCode = normalizedCode.replace(
    /\bpackage\b(?!\s+body)/gi,
    "PACKAGE"
  );
  normalizedCode = normalizedCode.replace(/\bfunction\b/gi, "FUNCTION");
  normalizedCode = normalizedCode.replace(/\bprocedure\b/gi, "PROCEDURE");
  normalizedCode = normalizedCode.replace(/\bis\b/gi, "IS");
  normalizedCode = normalizedCode.replace(/\bas\b/gi, "AS");
  normalizedCode = normalizedCode.replace(/\bend\b/gi, "END");
  normalizedCode = normalizedCode.replace(/\bcreate\b/gi, "CREATE");
  normalizedCode = normalizedCode.replace(/\bor\b/gi, "OR");
  normalizedCode = normalizedCode.replace(/\breplace\b/gi, "REPLACE");

  // PASO 5: Eliminar cualquier referencia al esquema que podría permanecer
  normalizedCode = normalizedCode.replace(
    new RegExp(`\\b\\w+\\.${objectName}\\b`, "gi"),
    objectName
  );

  return normalizedCode;
}

ipcMain.on(
  "compare-code",
  async (event, { fileContent, schema, objectType, objectName, filePath }) => {
    if (!userSession) {
      event.reply("compare-response", "Error: No hay usuario autenticado.");
      return;
    }

    try {
      const connection = await oracledb.getConnection(userSession);

      let dbCode = "";
      let specCode = "";
      let bodyCode = "";
      let objectDates = { created: null, lastModified: null }; // Inicializar aquí
      let fileContainsPackageBody = fileContent.match(/\bpackage\s+body\b/i);
      let fileContainsPackageSpec = fileContent.match(
        /\bpackage\b(?!\s+body)/i
      );

      // Obtener fechas de creación/modificación del objeto en la base de datos
      try {
        const dateResult = await connection.execute(
          `SELECT 
            CREATED, 
            LAST_DDL_TIME 
          FROM ALL_OBJECTS 
          WHERE OWNER = :schema 
          AND OBJECT_NAME = :objectName 
          AND OBJECT_TYPE = :objectType`,
          { 
            schema, 
            objectName, 
            objectType: objectType === 'PACKAGE BODY' ? 'PACKAGE BODY' : objectType 
          }
        );

        if (dateResult.rows && dateResult.rows.length > 0) {
          objectDates.created = dateResult.rows[0][0];
          objectDates.lastModified = dateResult.rows[0][1];
        }
      } catch (dateError) {
        console.log("Error al obtener fechas del objeto:", dateError);
      }

      // Obtener fechas del archivo local si se proporcionó la ruta
      let fileDates = { created: null, modified: null };
      if (filePath) {
        try {
          const stats = fs.statSync(filePath);
          fileDates.created = stats.birthtime;
          fileDates.modified = stats.mtime;
          console.log('fileDates calculado:', fileDates); // Depurar aquí
        } catch (fileError) {
          console.log("Error al obtener fechas del archivo:", fileError);
        }
      }

      // Para PACKAGE, obtener tanto spec como body
      if (objectType === "PACKAGE") {
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

        if (result.rows.length > 0) {
          let currentType = null;
          let currentCode = [];

          for (const row of result.rows) {
            const type = row[0]; // 'PACKAGE' o 'PACKAGE BODY'
            const text = row[2]; // El texto de la línea

            if (type !== currentType) {
              if (currentType === "PACKAGE") {
                specCode = currentCode.join("");
              } else if (currentType === "PACKAGE BODY") {
                bodyCode = currentCode.join("");
              }
              currentType = type;
              currentCode = [];
            }

            currentCode.push(text);
          }

          if (currentType === "PACKAGE") {
            specCode = currentCode.join("");
          } else if (currentType === "PACKAGE BODY") {
            bodyCode = currentCode.join("");
          }

          // IMPORTANTE: Si seleccionaste PACKAGE y el archivo contiene solo PACKAGE o PACKAGE BODY
          // pero queremos mostrar el PACKAGE completo de la BD
          if (fileContainsPackageBody && !fileContainsPackageSpec) {
            console.log(
              "Archivo contiene solo PACKAGE BODY, comparando con PACKAGE BODY de la BD"
            );
            dbCode = bodyCode;
            objectType = "PACKAGE BODY";
          } else if (fileContainsPackageSpec && !fileContainsPackageBody) {
            console.log(
              "Archivo contiene solo PACKAGE, comparando con PACKAGE de la BD"
            );
            dbCode = specCode;
          } else {
            // Concatenar spec y body para mostrar el paquete completo
            console.log("Mostrando PACKAGE completo (spec + body)");
            if (specCode) {
              // Normalizar specCode con tipo PACKAGE
              specCode = normalizeOracleCode(specCode, "PACKAGE", objectName);
              dbCode = specCode;
            }
            if (bodyCode) {
              // Normalizar bodyCode con tipo PACKAGE BODY
              bodyCode = normalizeOracleCode(
                bodyCode,
                "PACKAGE BODY",
                objectName
              );
              // Concatenar body directamente sin separadores ni saltos adicionales
              dbCode += "/\n";
              dbCode += bodyCode + "/\n";
            }
          }
        }
      } else if (objectType === "PACKAGE BODY") {
        // Si específicamente se seleccionó PACKAGE BODY
        const result = await connection.execute(
          `SELECT TEXT
                   FROM ALL_SOURCE 
                   WHERE OWNER = :schema 
                   AND NAME = :objectName 
                   AND TYPE = 'PACKAGE BODY'
                   ORDER BY LINE`,
          { schema, objectName },
          { fetchInfo: { TEXT: { type: oracledb.STRING } } }
        );

        if (result.rows.length > 0) {
          bodyCode = result.rows.map((row) => row[0]).join("");
          dbCode = bodyCode;
        }
      } else {
        // Para otros tipos de objetos (FUNCTION, PROCEDURE)
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

          // Aplicar normalización especial para funciones
          if (objectType === "FUNCTION") {
            // Para el código de la BD
            dbCode = dbCode.toUpperCase();

            // Eliminar "CREATE OR REPLACE" del código de BD si existe
            dbCode = dbCode.replace(/CREATE\s+OR\s+REPLACE\s+/gi, "");

            // Eliminar cualquier referencia al esquema en el encabezado
            dbCode = dbCode.replace(
              new RegExp(`FUNCTION\\s+\\w+\\.${objectName}`, "gi"),
              `FUNCTION ${objectName}`
            );

            // Asegurar que el encabezado sea solo "FUNCTION nombreFuncion"
            if (!dbCode.startsWith("FUNCTION")) {
              const nameIndex = dbCode.indexOf(objectName.toUpperCase());
              if (nameIndex > -1) {
                dbCode =
                  `FUNCTION ${objectName.toUpperCase()}` +
                  dbCode.substring(nameIndex + objectName.length);
              }
            }

            // Para el archivo local - eliminar "CREATE OR REPLACE" si existe
            fileContent = fileContent.toUpperCase();
            fileContent = fileContent.replace(/CREATE\s+OR\s+REPLACE\s+/gi, "");

            // Eliminar cualquier referencia al esquema en el encabezado
            fileContent = fileContent.replace(
              new RegExp(`FUNCTION\\s+\\w+\\.${objectName}`, "gi"),
              `FUNCTION ${objectName}`
            );

            // Asegurar que el encabezado sea solo "FUNCTION nombreFuncion"
            if (!fileContent.startsWith("FUNCTION")) {
              const nameIndex = fileContent.indexOf(objectName.toUpperCase());
              if (nameIndex > -1) {
                fileContent =
                  `FUNCTION ${objectName.toUpperCase()}` +
                  fileContent.substring(nameIndex + objectName.length);
              }
            }
            // Añadir slash al final del código de BD si no existe
            dbCode = dbCode + "/\n"; // Añadir slash con saltos de línea
          }

          // Aplicar normalización especial para procedimientos
          if (objectType === "PROCEDURE") {
            // Normalizar el código de la BD (convertir todo a mayúsculas)
            dbCode = dbCode.toUpperCase();

            // Eliminar "CREATE OR REPLACE" del código de BD si existe
            dbCode = dbCode.replace(/CREATE\s+OR\s+REPLACE\s+/gi, "");

            // Eliminar comillas alrededor del nombre del procedimiento
            dbCode = dbCode.replace(
              new RegExp(`PROCEDURE\\s+"${objectName}"`, "gi"),
              `PROCEDURE ${objectName}`
            );

            // Eliminar cualquier referencia al esquema en el encabezado
            dbCode = dbCode.replace(
              new RegExp(`PROCEDURE\\s+\\w+\\.${objectName}`, "gi"),
              `PROCEDURE ${objectName}`
            );
            dbCode = dbCode.replace(
              new RegExp(`PROCEDURE\\s+\\w+\\."${objectName}"`, "gi"),
              `PROCEDURE ${objectName}`
            );

            // Asegurar que el encabezado sea solo "PROCEDURE nombreProcedimiento" sin comillas
            if (!dbCode.startsWith("PROCEDURE")) {
              // Buscar el nombre del procedimiento con posibles comillas
              const quotedNameRegex = new RegExp(`"${objectName}"`, "i");
              const unquotedNameRegex = new RegExp(`\\b${objectName}\\b`, "i");

              let nameIndex = -1;
              if (dbCode.match(quotedNameRegex)) {
                nameIndex = dbCode.indexOf(`"${objectName.toUpperCase()}"`);
                if (nameIndex > -1) {
                  // Reemplazar con el nombre sin comillas
                  dbCode =
                    `PROCEDURE ${objectName.toUpperCase()}` +
                    dbCode.substring(nameIndex + objectName.length + 2); // +2 por las comillas
                }
              } else if (dbCode.match(unquotedNameRegex)) {
                nameIndex = dbCode.indexOf(objectName.toUpperCase());
                if (nameIndex > -1) {
                  dbCode =
                    `PROCEDURE ${objectName.toUpperCase()}` +
                    dbCode.substring(nameIndex + objectName.length);
                }
              }
            }

            // Añadir slash al final del código de BD si no existe
            dbCode = dbCode + "\n/\n"; // Añadir slash con saltos de línea
          }
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

      const originalFileContent = fileContent;
      const originalDbCode = dbCode;

      // Tratamiento especial para FUNCTION y PROCEDURE
      if (objectType === "FUNCTION") {
        // Convertir todo el contenido del archivo a mayúsculas
        fileContent = fileContent.toUpperCase();

        // Normalizar el encabezado
        if (fileContent.includes("CREATE OR REPLACE")) {
          fileContent = fileContent.replace(
            /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:\w+\.)?(\w+)/i,
            `CREATE OR REPLACE FUNCTION ${objectName.toUpperCase()}`
          );
        } else if (!fileContent.startsWith("FUNCTION")) {
          // Si no tiene ningún encabezado estándar, asegurar que comience con FUNCTION
          const nameIndex = fileContent.indexOf(objectName.toUpperCase());
          if (nameIndex > -1) {
            fileContent =
              `FUNCTION ${objectName.toUpperCase()}` +
              fileContent.substring(nameIndex + objectName.length);
          }
        }
      } else if (objectType === "PROCEDURE") {
        // Convertir todo el contenido del archivo a mayúsculas
        fileContent = fileContent.toUpperCase();

        // Eliminar "CREATE OR REPLACE" del código del archivo si existe
        fileContent = fileContent.replace(/CREATE\s+OR\s+REPLACE\s+/gi, "");

        // Eliminar comillas alrededor del nombre del procedimiento
        fileContent = fileContent.replace(
          new RegExp(`PROCEDURE\\s+"${objectName}"`, "gi"),
          `PROCEDURE ${objectName}`
        );

        // Eliminar cualquier referencia al esquema en el encabezado
        fileContent = fileContent.replace(
          new RegExp(`PROCEDURE\\s+\\w+\\.${objectName}`, "gi"),
          `PROCEDURE ${objectName}`
        );
        fileContent = fileContent.replace(
          new RegExp(`PROCEDURE\\s+\\w+\\."${objectName}"`, "gi"),
          `PROCEDURE ${objectName}`
        );

        // Asegurar que el encabezado sea solo "PROCEDURE nombreProcedimiento" sin comillas
        if (!fileContent.startsWith("PROCEDURE")) {
          // Similar a la lógica para dbCode
          const quotedNameRegex = new RegExp(`"${objectName}"`, "i");
          const unquotedNameRegex = new RegExp(`\\b${objectName}\\b`, "i");

          let nameIndex = -1;
          if (fileContent.match(quotedNameRegex)) {
            nameIndex = fileContent.indexOf(`"${objectName.toUpperCase()}"`);
            if (nameIndex > -1) {
              fileContent =
                `PROCEDURE ${objectName.toUpperCase()}` +
                fileContent.substring(nameIndex + objectName.length + 2);
            }
          } else if (fileContent.match(unquotedNameRegex)) {
            nameIndex = fileContent.indexOf(objectName.toUpperCase());
            if (nameIndex > -1) {
              fileContent =
                `PROCEDURE ${objectName.toUpperCase()}` +
                fileContent.substring(nameIndex + objectName.length);
            }
          }
        }
      }
      // Cuando se normaliza el archivo local para PACKAGE, verificar si es package o package body
      else if (fileContainsPackageBody) {
        console.log("Archivo contiene PACKAGE BODY");
        // Si el archivo tiene PACKAGE BODY, normalizar como PACKAGE BODY
        fileContent = fileContent.replace(
          /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+BODY\s+(?:\w+\.)?(\w+)/gi,
          `PACKAGE BODY ${objectName}`
        );
        fileContent = normalizeOracleCode(
          fileContent,
          "PACKAGE BODY",
          objectName
        );
      } else if (fileContainsPackageSpec) {
        console.log("Archivo contiene PACKAGE");
        // Si el archivo tiene PACKAGE spec, normalizar como PACKAGE
        fileContent = fileContent.replace(
          /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+(?:\w+\.)?(\w+)/gi,
          `PACKAGE ${objectName}`
        );
        fileContent = normalizeOracleCode(fileContent, "PACKAGE", objectName);
      }

      // Normalización adicional para asegurar que se eliminen esquemas y consistencia en PACKAGE
      if (objectType === "PACKAGE" || objectType === "PACKAGE BODY") {
        fileContent = fileContent.replace(
          /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+(?:\w+\.)?(\w+)/gi,
          `PACKAGE ${objectName}`
        );
        fileContent = fileContent.replace(
          /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+BODY\s+(?:\w+\.)?(\w+)/gi,
          `PACKAGE BODY ${objectName}`
        );
        fileContent = fileContent.replace(
          new RegExp(`\\b\\w+\\.${objectName}\\b`, "gi"),
          objectName
        );

        // Normalizar palabras clave a mayúsculas para PACKAGE
        fileContent = fileContent.replace(/\bcreate\b/gi, "CREATE");
        fileContent = fileContent.replace(/\bor\b/gi, "OR");
        fileContent = fileContent.replace(/\breplace\b/gi, "REPLACE");
        fileContent = fileContent.replace(
          /\bpackage\b(?!\s+body)/gi,
          "PACKAGE"
        );
        fileContent = fileContent.replace(
          /\bpackage\s+body\b/gi,
          "PACKAGE BODY"
        );
        fileContent = fileContent.replace(/\bis\b/gi, "IS");
      }

      console.log(
        "Original File Content (primeras 100 chars):",
        originalFileContent.substring(0, 100)
      );
      console.log(
        "Normalized File Content (primeras 100 chars):",
        fileContent.substring(0, 100)
      );
      console.log(
        "Original DB Code (primeras 100 chars):",
        originalDbCode.substring(0, 100)
      );
      console.log(
        "Normalized DB Code (primeras 100 chars):",
        dbCode.substring(0, 100)
      );

      // Normalizar saltos de línea
      dbCode = dbCode.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      fileContent = fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      // Comparar el código
      const differences = diffLines(dbCode, fileContent, {
        ignoreWhitespace: false,
        newlineIsToken: true,
      });

      // Verificar si hay diferencias
      const hasDifferences = differences.some(
        (part) => part.added || part.removed
      );

      // Preparar respuesta
      const response = JSON.stringify({
        dbCode,
        fileContent,
        differences,
        hasDifferences,
        specCodePresent: !!specCode,
        bodyCodePresent: !!bodyCode,
        objectDates,
        fileDates
      });

      event.reply("compare-response", response);
      await connection.close();
    } catch (error) {
      console.error(error);
      event.reply("compare-response", `Error: ${error.message}`);
    }
  }
);

// Diálogo para seleccionar carpeta
ipcMain.on('open-folder-dialog', async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
      });
      
      if (!result.canceled && result.filePaths.length > 0) {
        event.reply('selected-folder', result.filePaths[0]);
      }
    } catch (error) {
      console.error('Error al abrir el diálogo de carpetas:', error);
    }
  });
  
  // Escanear carpeta para buscar archivos
  ipcMain.on('scan-folder', async (event, { folderPath, extensions }) => {
    try {
      // Comprobar que la ruta existe
      if (!fs.existsSync(folderPath)) {
        event.reply('scan-results', []);
        return;
      }
      
      // Función recursiva para escanear directorios
      function scanDirectory(dirPath) {
        let results = [];
        const items = fs.readdirSync(dirPath);
        
        for (const item of items) {
          const itemPath = path.join(dirPath, item);
          const stat = fs.statSync(itemPath);
          
          if (stat.isDirectory()) {
            // Recursivamente escanear subdirectorios
            results = results.concat(scanDirectory(itemPath));
          } else {
            // Verificar si la extensión del archivo coincide con alguna de las solicitadas
            const ext = path.extname(item).toLowerCase();
            if (extensions.includes(ext)) {
              results.push(itemPath);
            }
          }
        }
        
        return results;
      }
      
      const files = scanDirectory(folderPath);
      event.reply('scan-results', files);
      
    } catch (error) {
      console.error('Error al escanear la carpeta:', error);
      event.reply('scan-results', []);
    }
  });
  
  ipcMain.on('read-file', async (event, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        // Leer como buffer para tener flexibilidad con la codificación
        const buffer = fs.readFileSync(filePath);
        
        // Intentar varias codificaciones comunes en orden de probabilidad
        const encodings = ['windows-1252', 'ISO-8859-1', 'latin1', 'utf8'];
        let fileContent = null;
        
        // Detectar codificación probando cada una
        for (const encoding of encodings) {
          try {
            // Intentar decodificar con esta codificación
            const decodedText = buffer.toString(encoding);
            
            // Verificar si hay caracteres extraños que indican codificación incorrecta
            if (!decodedText.includes('�')) {
              fileContent = decodedText;
              console.log(`Archivo leído correctamente con codificación: ${encoding}`);
              break;
            }
          } catch (encodingError) {
            console.log(`Error con codificación ${encoding}:`, encodingError.message);
          }
        }
        
        // Si todas las codificaciones fallan, usar windows-1252 como última opción
        if (!fileContent) {
          fileContent = buffer.toString('windows-1252');
          console.log('Usando windows-1252 como fallback');
        }
        
        event.reply('file-content', fileContent);
      } else {
        event.reply('file-content', null);
      }
    } catch (error) {
      console.error('Error al leer el archivo:', error);
      event.reply('file-content', null);
    }
  });