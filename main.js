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
      let fileContainsPackageBody = fileContent.match(/\bpackage\s+body\b/i);
      let fileContainsPackageSpec = fileContent.match(
        /\bpackage\b(?!\s+body)/i
      );

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

      // Cuando se normaliza el archivo local, verificar si es package o package body
      if (fileContainsPackageBody) {
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
      } else {
        console.log("Archivo contiene PACKAGE");
        // Si el archivo tiene PACKAGE spec, normalizar como PACKAGE
        fileContent = fileContent.replace(
          /CREATE\s+OR\s+REPLACE\s+PACKAGE\s+(?:\w+\.)?(\w+)/gi,
          `PACKAGE ${objectName}`
        );
        fileContent = normalizeOracleCode(fileContent, "PACKAGE", objectName);
      }

      // Normalización adicional para asegurar que se eliminen esquemas y consistencia
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

      // Normalizar todas las palabras clave a mayúsculas
      fileContent = fileContent.replace(/\bcreate\b/gi, "CREATE");
      fileContent = fileContent.replace(/\bor\b/gi, "OR");
      fileContent = fileContent.replace(/\breplace\b/gi, "REPLACE");
      fileContent = fileContent.replace(/\bpackage\b(?!\s+body)/gi, "PACKAGE");
      fileContent = fileContent.replace(/\bpackage\s+body\b/gi, "PACKAGE BODY");
      fileContent = fileContent.replace(/\bis\b/gi, "IS");

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
      });

      event.reply("compare-response", response);
      await connection.close();
    } catch (error) {
      console.error(error);
      event.reply("compare-response", `Error: ${error.message}`);
    }
  }
);
