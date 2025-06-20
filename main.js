const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const oracledb = require("oracledb");
require("dotenv").config(); // Cargar variables de entorno
const { diffLines } = require("diff"); // Importamos la librería de comparación
const fs = require("fs");

let mainWindow;
let userSession = null; // Guardará la sesión del usuario autenticado
// Función para encontrar el archivo tnsnames.ora en Windows
function findTnsnamesFile() {
  // Posibles ubicaciones en Windows
  const possibleLocations = [];

  // Usando variables de entorno de Oracle
  if (process.env.ORACLE_HOME) {
    possibleLocations.push(
      path.join(process.env.ORACLE_HOME, "network", "admin", "tnsnames.ora")
    );
  }
  if (process.env.TNS_ADMIN) {
    possibleLocations.push(path.join(process.env.TNS_ADMIN, "tnsnames.ora"));
  }

  // Ubicaciones comunes de Oracle en Windows
  possibleLocations.push(
    path.join(
      "C:",
      "Oracle",
      "product",
      "client",
      "network",
      "admin",
      "tnsnames.ora"
    )
  );
  possibleLocations.push(
    path.join(
      "C:",
      "Program Files",
      "Oracle",
      "client",
      "network",
      "admin",
      "tnsnames.ora"
    )
  );
  possibleLocations.push(
    path.join("C:", "app", "client", "network", "admin", "tnsnames.ora")
  );
  possibleLocations.push(
    path.join("C:", "instantclient_19_10", "network", "admin", "tnsnames.ora")
  );

  possibleLocations.push(
    path.join(
      "C:",
      "app",
      "client",
      "kcabrerac",
      "product",
      "19.0.0",
      "client_1",
      "network",
      "admin",
      "tnsnames.ora"
    )
  );

  // También buscar en el directorio de la aplicación
  possibleLocations.push(path.join(app.getAppPath(), "tnsnames.ora"));

  // Verificar cada ubicación
  for (const location of possibleLocations) {
    if (fs.existsSync(location)) {
      console.log(`Archivo tnsnames.ora encontrado en: ${location}`);
      return location;
    }
  }

  console.log("No se encontró el archivo tnsnames.ora");
  return null; // No se encontró el archivo
}

// Función para analizar el archivo tnsnames.ora
function parseTnsnames(filePath) {
  if (!filePath) return {};

  try {
    // Leer el archivo con codificación Windows
    const content = fs.readFileSync(filePath, { encoding: "utf8" });
    const connections = {};

    // Expresión regular para encontrar nombres de conexión
    // Busca líneas que empiecen con un nombre válido seguido de un signo =
    const aliasPattern = /^\s*([\w\d\.\-]+)\s*=/gm;
    let match;

    while ((match = aliasPattern.exec(content)) !== null) {
      const alias = match[1].trim();
      // Evitar capturar palabras clave o comentarios
      if (!alias.startsWith("#") && !alias.includes(" ")) {
        connections[alias] = alias;
      }
    }

    console.log(
      `Conexiones encontradas: ${Object.keys(connections).join(", ")}`
    );
    return connections;
  } catch (error) {
    console.error("Error al leer tnsnames.ora:", error);
    return {};
  }
}

// Variable global para almacenar las conexiones de TNS
let tnsConnections = {};

app.whenReady().then(() => {
  // Buscar y cargar el archivo tnsnames.ora
  const tnsnamesPath = findTnsnamesFile();
  if (tnsnamesPath) {
    tnsConnections = parseTnsnames(tnsnamesPath);
  }

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

// Agregar evento para enviar las conexiones al frontend
ipcMain.on("get-tns-connections", (event) => {
  event.reply("tns-connections", tnsConnections);
});

ipcMain.on("login-attempt", async (event, credentials) => {
  try {
    const selectedTns = credentials.selectedConnection;
    // Buscar el archivo tnsnames.ora primero
    const tnsnamesPath = findTnsnamesFile();
    if (tnsnamesPath) {
      // Configurar la variable de entorno TNS_ADMIN con la ruta donde se encontró el archivo
      process.env.TNS_ADMIN = path.dirname(tnsnamesPath);
      console.log(`TNS_ADMIN configurado a: ${process.env.TNS_ADMIN}`);
    } else {
      console.log("No se encontró tnsnames.ora, la conexión podría fallar");
    }

    let connectionString;
    if (tnsConnections[selectedTns]) {
      // Usar el alias TNS directamente
      connectionString = selectedTns;
    } else {
      // Usar la configuración del .env como fallback
      connectionString = process.env[selectedTns];
      if (!connectionString) {
        event.reply("login-response", "Error: Conexión no válida.");
        return;
      }
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
ipcMain.handle("fetch-owner-from-db", async (event, objectName, objectType) => {
  console.log(
    "[fetch-owner-from-db] Buscando owner de:",
    objectName,
    "tipo:",
    objectType
  );
  if (!userSession) {
    console.log("[fetch-owner-from-db] No hay sesión activa");
    return null;
  }
  try {
    const connection = await oracledb.getConnection({
      user: userSession.user,
      password: userSession.password,
      connectionString: userSession.connectionString,
    });

    const result = await connection.execute(
      `SELECT OWNER FROM DBA_OBJECTS WHERE OBJECT_NAME = :objectName AND OBJECT_TYPE = :objectType`,
      {
        objectName: objectName.toUpperCase(),
        objectType: objectType.toUpperCase(),
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    await connection.close();

    if (result.rows.length > 0) {
      console.log(
        "[fetch-owner-from-db] Owner encontrado:",
        result.rows[0].OWNER
      );
      return result.rows[0].OWNER;
    } else {
      console.log(
        "[fetch-owner-from-db] No se encontró el objeto en DBA_OBJECTS"
      );
      return null;
    }
  } catch (err) {
    console.error("[fetch-owner-from-db] Error:", err);
    return null;
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
  async (
    event,
    { fileContent, schema, objectType, objectName, filePath, fileMetadata }
  ) => {
    console.log("Recibido en main.js - filePath:", filePath);
    console.log("Tipo de dato de filePath:", typeof filePath);
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
            objectType:
              objectType === "PACKAGE BODY" ? "PACKAGE BODY" : objectType,
          }
        );

        if (dateResult.rows && dateResult.rows.length > 0) {
          objectDates.created = dateResult.rows[0][0];
          objectDates.lastModified = dateResult.rows[0][1];
        }
      } catch (dateError) {
        console.log("Error al obtener fechas del objeto:", dateError);
      }
      console.log(
        "Intentando obtener fechas para el archivo en ruta:",
        filePath
      );

      // Obtener fechas del archivo
      let fileDates = { created: null, modified: null };

      // Si tenemos la metadata del archivo (para comparación individual)
      if (fileMetadata) {
        // Usamos lastModified para ambas fechas ya que el objeto File solo proporciona esa fecha
        fileDates.modified = new Date(fileMetadata.lastModified);
        fileDates.created = new Date(fileMetadata.lastModified); // Misma fecha como fallback
        console.log("fileDates calculado desde metadata:", fileDates);
      }
      // Si tenemos la ruta del archivo (para comparación por lotes)
      else if (filePath) {
        try {
          const stats = fs.statSync(filePath);
          fileDates.created = stats.birthtime;
          fileDates.modified = stats.mtime;
          console.log("fileDates calculado desde ruta de archivo:", fileDates);
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
      console.log("Enviando respuesta con fechas:", {
        objectDates: objectDates,
        fileDates: fileDates,
      });

      // Preparar respuesta
      const response = JSON.stringify({
        dbCode,
        fileContent,
        differences,
        hasDifferences,
        specCodePresent: !!specCode,
        bodyCodePresent: !!bodyCode,
        objectDates,
        fileDates,
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
ipcMain.on("open-folder-dialog", async (event) => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });

    if (!result.canceled && result.filePaths.length > 0) {
      event.reply("selected-folder", result.filePaths[0]);
    }
  } catch (error) {
    console.error("Error al abrir el diálogo de carpetas:", error);
  }
});

// Escanear carpeta para buscar archivos
ipcMain.on("scan-folder", async (event, { folderPath, extensions }) => {
  try {
    // Comprobar que la ruta existe
    if (!fs.existsSync(folderPath)) {
      event.reply("scan-results", []);
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
    event.reply("scan-results", files);
  } catch (error) {
    console.error("Error al escanear la carpeta:", error);
    event.reply("scan-results", []);
  }
});

ipcMain.on("read-file", async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      // Leer como buffer para tener flexibilidad con la codificación
      const buffer = fs.readFileSync(filePath);

      // Intentar varias codificaciones comunes en orden de probabilidad
      const encodings = ["windows-1252", "ISO-8859-1", "latin1", "utf8"];
      let fileContent = null;

      // Detectar codificación probando cada una
      for (const encoding of encodings) {
        try {
          // Intentar decodificar con esta codificación
          const decodedText = buffer.toString(encoding);

          // Verificar si hay caracteres extraños que indican codificación incorrecta
          if (!decodedText.includes("�")) {
            fileContent = decodedText;
            console.log(
              `Archivo leído correctamente con codificación: ${encoding}`
            );
            break;
          }
        } catch (encodingError) {
          console.log(
            `Error con codificación ${encoding}:`,
            encodingError.message
          );
        }
      }

      // Si todas las codificaciones fallan, usar windows-1252 como última opción
      if (!fileContent) {
        fileContent = buffer.toString("windows-1252");
        console.log("Usando windows-1252 como fallback");
      }

      event.reply("file-content", fileContent);
    } else {
      event.reply("file-content", null);
    }
  } catch (error) {
    console.error("Error al leer el archivo:", error);
    event.reply("file-content", null);
  }
});
ipcMain.handle("get-database-name", async () => {
  if (!userSession) {
    console.log("[get-database-name] No hay sesión activa");
    return "Desconocida"; // Si no hay sesión activa, devolvemos un valor por defecto
  }

  try {
    const connection = await oracledb.getConnection(userSession);

    // Ejecutamos una consulta para obtener el nombre de la base de datos
    const result = await connection.execute(`SELECT name FROM v$database`);

    // Cerrar la conexión
    await connection.close();

    // Devolver el nombre de la base de datos
    return result.rows[0][0]; // Suponiendo que la consulta devuelve el nombre de la base de datos en la primera columna
  } catch (error) {
    console.error(
      "[get-database-name] Error al obtener el nombre de la base de datos:",
      error
    );
    return "Desconocida"; // Si ocurre un error, devolvemos un valor por defecto
  }
});
async function readClobAsString(clob) {
  return new Promise((resolve, reject) => {
    if (clob === null) {
      resolve(null);
      return;
    }

    let clobData = "";

    clob.setEncoding("utf8");
    clob.on("data", (chunk) => {
      clobData += chunk;
    });
    clob.on("end", () => {
      resolve(clobData);
    });
    clob.on("error", (err) => {
      reject(err);
    });
  });
}
function insertSlashesInPackageDDL(ddl, objectName) {
  // Busca el final de la spec: línea que contiene "END <objectName>;"
  // La función es case insensitive
  const regexEndSpec = new RegExp(`(END\\s+${objectName}\\s*;)`, "i");

  const match = ddl.match(regexEndSpec);
  if (!match) {
    // No encontró el final de la spec, solo agrega slash al final
    return ddl.trim() + "\n/\n";
  }

  // Índice donde termina la spec
  const endIndex = match.index + match[0].length;

  // Divide el ddl en spec y resto (body)
  const specPart = ddl.slice(0, endIndex).trim();
  const restPart = ddl.slice(endIndex).trim();

  // Asegura que cada parte termina con /
  const specWithSlash = specPart.endsWith("/") ? specPart : specPart + "\n/";
  const restWithSlash =
    restPart.length === 0
      ? ""
      : restPart.endsWith("/")
      ? restPart
      : restPart + "\n/";

  // Concatenar y devolver
  return specWithSlash + "\n\n" + restWithSlash;
}

// Función para limpiar el DDL obtenido de Oracle
function cleanDDL(ddl, objectName) {
  if (!ddl) return ddl;
  
  let cleanedDDL = ddl;
  
  // 1. Remover la palabra EDITIONABLE
  cleanedDDL = cleanedDDL.replace(/\bEDITIONABLE\s+/gi, '');
  
  // 2. Remover solo las comillas dobles, manteniendo esquema y objeto
  // Convierte "SCHEMA"."OBJECT" a SCHEMA.OBJECT
  cleanedDDL = cleanedDDL.replace(/"([^"]+)"\."([^"]+)"/g, '$1.$2');
  // También remover comillas individuales si las hay
  cleanedDDL = cleanedDDL.replace(/"([^"]+)"/g, '$1');
  
  
  return cleanedDDL;
}

// Función modificada de backupObjectCode
async function backupObjectCode(
  connection,
  schema,
  objectName,
  backupDir,
  objectType
) {
  try {
    const schemaU = schema
      ? schema.toUpperCase()
      : connection.user
      ? connection.user.toUpperCase()
      : null;
    const objectNameU = objectName.toUpperCase();

    if (!schemaU)
      throw new Error("No se pudo determinar el esquema para el backup");

    let ddlObjectType = objectType.toUpperCase();
    if (ddlObjectType === "PACKAGE BODY") ddlObjectType = "PACKAGE_BODY";

    // Verificar si el objeto existe
    const objectExistsQuery = `
      SELECT COUNT(*) as OBJECT_COUNT 
      FROM ALL_OBJECTS 
      WHERE OWNER = :owner 
        AND OBJECT_NAME = :obj_name 
        AND OBJECT_TYPE = :obj_type
    `;

    const existsResult = await connection.execute(
      objectExistsQuery,
      { 
        owner: schemaU, 
        obj_name: objectNameU, 
        obj_type: ddlObjectType 
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!existsResult.rows.length || existsResult.rows[0].OBJECT_COUNT === 0) {
      console.log(`Objeto ${objectNameU} de tipo ${objectType} no existe en esquema ${schemaU}`);
      return null;
    }

    // Obtener el DDL
    let result;
    try {
      result = await connection.execute(
        `SELECT DBMS_METADATA.GET_DDL(:obj_type, :obj_name, :owner) AS DDL FROM DUAL`,
        { obj_type: ddlObjectType, obj_name: objectNameU, owner: schemaU },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
    } catch (ddlError) {
      if (ddlError.message.includes('ORA-31603')) {
        console.log(`Objeto ${objectNameU} no encontrado para DDL en esquema ${schemaU}`);
        return null;
      }
      throw ddlError;
    }

    if (!result.rows.length || !result.rows[0].DDL) {
      console.log(`No se pudo obtener DDL para ${objectNameU}`);
      return null;
    }

    const clob = result.rows[0].DDL;
    const ddl = await readClobAsString(clob);

    if (!ddl) {
      throw new Error("No se pudo leer el DDL completo como texto.");
    }

    // *** AQUÍ ES LA PARTE NUEVA: Limpiar el DDL ***
    const cleanedDDL = cleanDDL(ddl, objectNameU);
    const ddlWithSlashes = insertSlashesInPackageDDL(cleanedDDL, objectNameU);

    // *** NUEVA LÓGICA DE ESTRUCTURA DE CARPETAS ***
    const now = new Date();
    const timeOffset = now.getTimezoneOffset();
    now.setMinutes(now.getMinutes() - timeOffset);

    // Obtener componentes de fecha
    const year = now.getFullYear().toString(); // "2025"
    const month = (now.getMonth() + 1).toString().padStart(2, '0'); // "06"
    const day = now.getDate().toString().padStart(2, '0'); // "20"
    
    const yearMonth = year + month; // "202506"
    const monthDay = month + day;   // "0620"

    // Construir la ruta base
    const basePath = "\\\\INFO7324\\Base de Datos$\\Respaldo_Objetos_Pases";
    
    // Construir la ruta completa: basePath/2025/202506/0620/
    const yearPath = path.join(basePath, year);
    const yearMonthPath = path.join(yearPath, yearMonth);
    const finalPath = path.join(yearMonthPath, monthDay);

    // Crear las carpetas si no existen
    try {
      // Crear carpeta del año (ej: 2025)
      if (!fs.existsSync(yearPath)) {
        fs.mkdirSync(yearPath, { recursive: true });
        console.log(`Carpeta creada: ${yearPath}`);
      } else {
        console.log(`Carpeta ya existe: ${yearPath}`);
      }

      // Crear carpeta año-mes (ej: 202506)
      if (!fs.existsSync(yearMonthPath)) {
        fs.mkdirSync(yearMonthPath, { recursive: true });
        console.log(`Carpeta creada: ${yearMonthPath}`);
      } else {
        console.log(`Carpeta ya existe: ${yearMonthPath}`);
      }

      // Crear carpeta final mes-día (ej: 0620)
      if (!fs.existsSync(finalPath)) {
        fs.mkdirSync(finalPath, { recursive: true });
        console.log(`Carpeta creada: ${finalPath}`);
      } else {
        console.log(`Carpeta ya existe: ${finalPath}`);
      }

    } catch (mkdirError) {
      console.error('Error creando estructura de carpetas:', mkdirError);
      throw new Error(`No se pudo crear la estructura de carpetas: ${mkdirError.message}`);
    }

    // Generar nombre del archivo
    const fechaHora = now
      .toISOString()
      .replace(/T/, "_")
      .replace(/:/g, "")
      .split(".")[0];

    const safeSchema = schemaU.replace(/[^a-zA-Z0-9]/g, "_");
    const safeName = objectNameU.replace(/[^a-zA-Z0-9]/g, "_");

    // Determinar extensión
    let extension = ".sql";
    const objType = objectType ? objectType.toUpperCase() : "";

    if (objType.includes("PACKAGE BODY") || objType === "PACKAGE") {
      extension = ".pck";
    } else if (objType === "FUNCTION") {
      extension = ".fnc";
    } else if (objType === "PROCEDURE") {
      extension = ".prc";
    }

    // Nombre final del archivo
    const fileName = `${safeSchema}_${safeName}_${fechaHora}${extension}`;
    const backupFilePath = path.join(finalPath, fileName);

    // Guardar el archivo
    fs.writeFileSync(backupFilePath, ddlWithSlashes, "utf8");
    
    console.log(`Backup guardado en: ${backupFilePath}`);
    
    return backupFilePath;

  } catch (error) {
    console.error('Error en backupObjectCode:', error);
    throw error;
  }
}

async function applyScript(connection, scriptContent) {
  console.log('=== INICIANDO APLICACIÓN DE SCRIPT ===');
  console.log('Contenido del script:', scriptContent.substring(0, 200) + '...');
  
  // Dividir el contenido en bloques separados por líneas con solo "/"
  const blocks = scriptContent
    .split(/\r?\n/)
    .reduce((acc, line) => {
      if (line.trim() === "/") {
        acc.push("");
      } else {
        if (acc.length === 0) acc.push("");
        acc[acc.length - 1] += line + "\n";
      }
      return acc;
    }, [])
    .filter((block) => block.trim() !== "");

  console.log(`Bloques encontrados: ${blocks.length}`);
  
  try {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i].trim();
      console.log(`\n--- Ejecutando bloque ${i + 1} ---`);
      console.log('Contenido del bloque:', block.substring(0, 150) + '...');
      
      if (block.length === 0) {
        console.log('Bloque vacío, saltando...');
        continue;
      }
      
      try {
        const result = await connection.execute(block);
        console.log('Bloque ejecutado exitosamente');
        console.log('Resultado:', result);
        
        // Verificar si hay errores de compilación
        if (block.toUpperCase().includes('CREATE OR REPLACE')) {
          await checkCompilationErrors(connection, block);
        }
        
      } catch (blockError) {
        console.error(`ERROR en bloque ${i + 1}:`, blockError.message);
        console.error('Código de error:', blockError.errorNum);
        console.error('Stack completo:', blockError);
        
        // Hacer rollback explícito
        try {
          await connection.rollback();
          console.log('Rollback ejecutado');
        } catch (rollbackError) {
          console.error('Error en rollback:', rollbackError);
        }
        
        // IMPORTANTE: Retornar inmediatamente con success: false
        return {
          success: false,
          error: blockError,
          message: `Error en bloque ${i + 1}: ${blockError.message}`,
          errorCode: blockError.errorNum
        };
      }
    }
    
    // Si llegamos aquí, todos los bloques se ejecutaron exitosamente
    console.log('Todos los bloques ejecutados, haciendo commit...');
    await connection.commit();
    console.log('Commit realizado exitosamente');
    
    return { success: true };
    
  } catch (err) {
    console.error('ERROR GENERAL en applyScript:', err);
    
    // Rollback en caso de error general
    try {
      await connection.rollback();
      console.log('Rollback ejecutado por error general');
    } catch (rollbackError) {
      console.error('Error en rollback general:', rollbackError);
    }
    
    // IMPORTANTE: Retornar inmediatamente con success: false
    return {
      success: false,
      error: err,
      message: `Error general: ${err.message}`,
      errorCode: err.errorNum
    };
  }
}

// Función mejorada para verificar errores de compilación
async function checkCompilationErrors(connection, sqlBlock) {
  try {
    // Extraer el nombre del objeto del bloque SQL
    const match = sqlBlock.match(/CREATE\s+OR\s+REPLACE\s+(?:PACKAGE\s+BODY\s+|PACKAGE\s+|FUNCTION\s+|PROCEDURE\s+)([\w."]+)/i);
    if (!match) return;
    
    let objectName = match[1].replace(/"/g, "");
    if (objectName.includes('.')) {
      objectName = objectName.split('.')[1];
    }
    
    console.log(`Verificando errores de compilación para: ${objectName}`);
    
    // Consultar errores de compilación
    const errorQuery = `
      SELECT LINE, POSITION, TEXT, ATTRIBUTE
      FROM USER_ERRORS 
      WHERE NAME = UPPER(:objectName)
      ORDER BY SEQUENCE
    `;
    
    const result = await connection.execute(errorQuery, 
      { objectName: objectName.toUpperCase() },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    
    if (result.rows && result.rows.length > 0) {
      console.error('ERRORES DE COMPILACIÓN ENCONTRADOS:');
      result.rows.forEach((error, index) => {
        console.error(`Error ${index + 1}: Línea ${error.LINE}, Posición ${error.POSITION}: ${error.TEXT}`);
      });
      
      // Construir mensaje de error detallado
      const errorMessages = result.rows.map(err => 
        `Línea ${err.LINE}: ${err.TEXT}`
      ).join('; ');
      
      // IMPORTANTE: Lanzar error para que sea capturado por el catch
      throw new Error(`Errores de compilación en ${objectName}: ${errorMessages}`);
    }
    
    console.log(`No se encontraron errores de compilación para ${objectName}`);
    
  } catch (error) {
    console.error('Error verificando compilación:', error);
    // Re-lanzar el error para que sea manejado por el caller
    throw error;
  }
}
ipcMain.on("apply-scripts", async (event, data) => {
  const { scripts, backupPath } = data;

  if (!userSession) {
    event.reply("apply-scripts-response", {
      success: false,
      message: "No hay sesión activa.",
    });
    return;
  }

  if (!backupPath) {
    event.reply("apply-scripts-response", {
      success: false,
      message: "No se recibió ruta para backup.",
    });
    return;
  }

  let connection;
  const results = [];

  try {
    connection = await oracledb.getConnection(userSession);
    console.log('Conexión establecida para aplicar scripts');

    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      const { schema, objectName, objectType, content } = script;
      
      console.log(`\n=== PROCESANDO SCRIPT ${i + 1}/${scripts.length}: ${objectName} ===`);

      try {
        // Intentar crear backup
        console.log('Creando backup...');
        const backupFile = await backupObjectCode(
          connection,
          schema,
          objectName,
          backupPath,
          objectType
        );

        if (!backupFile) {
          results.push({
            objectName,
            status: "⚠️ Objeto no existe (nuevo) - Backup omitido",
          });
          console.log('No se requiere backup - objeto no existe');
        } else {
          results.push({
            objectName,
            status: `✅ Backup creado: ${path.basename(backupFile)}`,
          });
          console.log(`Backup creado: ${backupFile}`);
        }

        // Intentar aplicar script
        console.log('Aplicando script...');
        const execResult = await applyScript(connection, content);
        
        console.log('Resultado de applyScript:', execResult);

        // Verificar el resultado de la ejecución
        if (execResult && execResult.success === true) {
          results.push({ 
            objectName, 
            status: "✅ Aplicado con éxito" 
          });
          console.log(`✅ Script ${objectName} aplicado exitosamente`);
          
        } else {
          // ERROR DETECTADO - DETENER PROCESAMIENTO INMEDIATAMENTE
          console.error(`❌ Error en script ${objectName}:`, execResult);
          
          const errorMessage = execResult?.message || 
                             execResult?.error?.message || 
                             'Error desconocido en la ejecución del script';
          
          results.push({
            objectName,
            status: "❌ ERROR - PROCESO DETENIDO",
            error: errorMessage,
            errorCode: execResult?.errorCode
          });
          
          // Cerrar conexión inmediatamente
          try {
            await connection.close();
            console.log('Conexión cerrada por error');
          } catch (closeError) {
            console.error('Error cerrando conexión:', closeError);
          }
          
          // Enviar respuesta de error y SALIR
          event.reply("apply-scripts-response", { 
            success: false, 
            results,
            message: `❌ PROCESO DETENIDO: Error en el script "${objectName}". ${errorMessage}`,
            stoppedAt: i + 1,
            totalScripts: scripts.length,
            remainingScripts: scripts.length - (i + 1)
          });
          return; // SALIDA INMEDIATA
        }

      } catch (error) {
        // ERROR INESPERADO EN BACKUP O CUALQUIER OTRA OPERACIÓN
        console.error(`💥 Error inesperado procesando script ${objectName}:`, error);
        
        results.push({
          objectName,
          status: "💥 ERROR INESPERADO - PROCESO DETENIDO",
          error: error.message,
        });
        
        // Cerrar conexión inmediatamente
        try {
          await connection.close();
          console.log('Conexión cerrada por error inesperado');
        } catch (closeError) {
          console.error('Error cerrando conexión:', closeError);
        }
        
        // Enviar respuesta de error y SALIR
        event.reply("apply-scripts-response", { 
          success: false, 
          results,
          message: `💥 PROCESO DETENIDO: Error inesperado en "${objectName}". ${error.message}`,
          stoppedAt: i + 1,
          totalScripts: scripts.length,
          remainingScripts: scripts.length - (i + 1)
        });
        return; // SALIDA INMEDIATA
      }
    }

    // Si llegamos aquí, TODOS los scripts se aplicaron exitosamente
    console.log('🎉 TODOS LOS SCRIPTS APLICADOS EXITOSAMENTE');
    
    try {
      await connection.close();
      console.log('Conexión cerrada correctamente');
    } catch (closeError) {
      console.error('Error cerrando conexión:', closeError);
    }
    
    event.reply("apply-scripts-response", { 
      success: true, 
      results,
      message: `🎉 ÉXITO TOTAL: Todos los scripts (${scripts.length}) se aplicaron correctamente.`,
      processedScripts: scripts.length,
      totalScripts: scripts.length,
      remainingScripts: 0
    });
    
  } catch (err) {
    // Error de conexión general o error antes del bucle
    console.error('💥 Error general de conexión o inicialización:', err);
    
    if (connection) {
      try {
        await connection.close();
        console.log('Conexión cerrada por error general');
      } catch (closeError) {
        console.error('Error cerrando conexión:', closeError);
      }
    }
    
    event.reply("apply-scripts-response", {
      success: false,
      results,
      message: `💥 ERROR DE CONEXIÓN: ${err.message}`,
      stoppedAt: 0,
      totalScripts: scripts.length,
      remainingScripts: scripts.length
    });
  }
});