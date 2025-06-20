const { ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");

const folderPathInput = document.getElementById("folderPath");
const browseButton = document.getElementById("browseButton");
const startApplyButton = document.getElementById("startApplyButton");
const applyLoader = document.getElementById("applyLoader");
const resultContainer = document.getElementById("resultContainer");
const fileList = document.getElementById("fileList");

let scriptsAvailable = [];

// Abrir diálogo para seleccionar carpeta
browseButton.addEventListener("click", () => {
  ipcRenderer.send("open-folder-dialog");
});

// Recibir ruta seleccionada
ipcRenderer.on("selected-folder", (event, folderPath) => {
  if (folderPath) {
    folderPathInput.value = folderPath;
    loadScriptsList(folderPath);
  }
});

// Cuando el usuario escribe o pega una ruta, actualizamos lista también
folderPathInput.addEventListener("change", () => {
  const folderPath = folderPathInput.value.trim();
  if (folderPath) loadScriptsList(folderPath);
});

// Función para detectar esquema, nombre y tipo de objeto
function extractObjectInfo(fileContent, fileName) {
  // Busca en el contenido la línea con CREATE OR REPLACE y captura tipo y nombre del objeto
  const regex =
    /CREATE\s+OR\s+REPLACE\s+(PACKAGE BODY|PACKAGE|FUNCTION|PROCEDURE)\s+([\w."]+)/i;
  const match = fileContent.match(regex);

  if (!match) {
    throw new Error(`No se pudo encontrar patrón CREATE OR REPLACE válido en ${fileName}. El archivo debe contener una declaración SQL válida.`);
  }

  const objectType = match[1].toUpperCase();
  let fullName = match[2].replace(/"/g, ""); // quitar comillas

  let schema = null;
  let objectName = null;

  if (fullName.includes(".")) {
    const parts = fullName.split(".");
    schema = parts[0].toUpperCase();
    objectName = parts[1].toUpperCase();
  } else {
    objectName = fullName.toUpperCase();
  }

  return { schema, objectName, objectType };
}

// Función para actualizar el estado del botón "Aplicar Scripts"
function updateApplyButtonState() {
  const checkedBoxes = fileList.querySelectorAll("input[type=checkbox]:checked:not(#selectAllCheckbox)");
  startApplyButton.disabled = checkedBoxes.length === 0;
}

// Función para actualizar el estado del checkbox "Seleccionar todos"
function updateSelectAllCheckboxState() {
  const selectAllCheckbox = document.getElementById("selectAllCheckbox");
  if (!selectAllCheckbox) return;

  const allCheckboxes = fileList.querySelectorAll("input[type=checkbox]:not(#selectAllCheckbox)");
  const checkedCheckboxes = fileList.querySelectorAll("input[type=checkbox]:checked:not(#selectAllCheckbox)");
  
  if (checkedCheckboxes.length === 0) {
    selectAllCheckbox.indeterminate = false;
    selectAllCheckbox.checked = false;
  } else if (checkedCheckboxes.length === allCheckboxes.length) {
    selectAllCheckbox.indeterminate = false;
    selectAllCheckbox.checked = true;
  } else {
    selectAllCheckbox.indeterminate = true;
  }
}

// Cargar y listar scripts de la carpeta con checkbox
function loadScriptsList(folderPath) {
  fileList.innerHTML = "";
  resultContainer.innerHTML = "";
  startApplyButton.disabled = true;
  scriptsAvailable = [];

  try {
    const files = fs.readdirSync(folderPath);
    const validExts = [".pck", ".fnc", ".prc"];

    files.forEach((file) => {
      const ext = path.extname(file).toLowerCase();
      if (!validExts.includes(ext)) return;

      const fullPath = path.join(folderPath, file);
      const content = fs.readFileSync(fullPath, "utf8");
      const { schema, objectName, objectType } = extractObjectInfo(
        content,
        file
      );

      if (!objectType || !objectName) return;

      scriptsAvailable.push({
        file,
        fullPath,
        content,
        schema,
        objectName,
        objectType,
      });
    });

    if (scriptsAvailable.length === 0) {
      fileList.textContent = "No se encontraron scripts válidos en la carpeta.";
      return;
    }

    // Crear checkbox "Seleccionar todos"
    const selectAllDiv = document.createElement("div");
    selectAllDiv.style.marginBottom = "10px";
    selectAllDiv.style.paddingBottom = "10px";
    selectAllDiv.style.borderBottom = "1px solid #ccc";
    
    const selectAllCheckbox = document.createElement("input");
    selectAllCheckbox.type = "checkbox";
    selectAllCheckbox.id = "selectAllCheckbox";
    
    selectAllCheckbox.addEventListener("change", () => {
      const isChecked = selectAllCheckbox.checked;
      const allCheckboxes = fileList.querySelectorAll("input[type=checkbox]:not(#selectAllCheckbox)");
      
      allCheckboxes.forEach(checkbox => {
        checkbox.checked = isChecked;
      });
      
      updateApplyButtonState();
    });

    const selectAllLabel = document.createElement("label");
    selectAllLabel.htmlFor = "selectAllCheckbox";
    selectAllLabel.textContent = "Seleccionar todos";
    selectAllLabel.style.fontWeight = "bold";

    selectAllDiv.appendChild(selectAllCheckbox);
    selectAllDiv.appendChild(selectAllLabel);
    fileList.appendChild(selectAllDiv);

    // Crear checkboxes individuales
    scriptsAvailable.forEach((script) => {
      const div = document.createElement("div");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "chk_" + script.file;
      checkbox.dataset.filePath = script.fullPath;
      checkbox.dataset.schema = script.schema || "";
      checkbox.dataset.objectName = script.objectName;
      checkbox.dataset.objectType = script.objectType;

      checkbox.addEventListener("change", () => {
        updateApplyButtonState();
        updateSelectAllCheckboxState();
      });

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = `${script.file} (${script.objectType})`;

      div.appendChild(checkbox);
      div.appendChild(label);

      fileList.appendChild(div);
    });

  } catch (err) {
    fileList.textContent = "Error leyendo la carpeta: " + err.message;
  }
}

// Al hacer click en aplicar, enviar solo los scripts seleccionados
startApplyButton.addEventListener("click", () => {
  const checkedBoxes = fileList.querySelectorAll(
    "input[type=checkbox]:checked:not(#selectAllCheckbox)"
  );

  if (checkedBoxes.length === 0) {
    alert("Selecciona al menos un script para aplicar.");
    return;
  }

  applyLoader.style.display = "block";
  resultContainer.innerHTML = "";
  startApplyButton.disabled = true;

  const scriptsToApply = [];

  checkedBoxes.forEach((checkbox) => {
    const script = scriptsAvailable.find(
      (s) => s.fullPath === checkbox.dataset.filePath
    );
    if (script) {
      scriptsToApply.push({
        schema: script.schema,
        objectName: script.objectName,
        objectType: script.objectType,
        content: script.content,
        filePath: script.fullPath,
      });
    }
  });

  ipcRenderer.send("apply-scripts", {
    scripts: scriptsToApply,
    backupPath: folderPathInput.value.trim(),
  });
});

// Escuchar respuesta del backend y mostrar resultados - VERSIÓN MEJORADA
ipcRenderer.on("apply-scripts-response", (event, data) => {
  applyLoader.style.display = "none";
  startApplyButton.disabled = false;

  if (!data.success) {
    // PROCESO DETENIDO POR ERROR
    console.error('Proceso detenido:', data);
    
    // Mostrar mensaje de error principal
    alert(`❌ PROCESO DETENIDO: ${data.message}`);
    
    // Si hay resultados parciales, mostrarlos con información detallada
    if (data.results && data.results.length > 0) {
      let html = "<h3>📋 Resultados del Proceso (INTERRUMPIDO)</h3>";
      
      // Panel de información del error
      html += "<div style='background-color: #ffebee; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #f44336;'>";
      html += "<h4 style='margin: 0 0 10px 0; color: #d32f2f;'>⚠️ PROCESO DETENIDO</h4>";
      html += `<p><strong>Motivo:</strong> ${data.message}</p>`;
      
      if (data.stoppedAt && data.totalScripts) {
        html += `<p><strong>Scripts procesados:</strong> ${data.stoppedAt} de ${data.totalScripts}</p>`;
        if (data.remainingScripts > 0) {
          html += `<p><strong>Scripts pendientes:</strong> ${data.remainingScripts} (NO ejecutados por seguridad)</p>`;
        }
      }
      
      html += "<p style='margin: 10px 0 0 0; font-style: italic;'>Los scripts restantes NO fueron ejecutados para evitar inconsistencias en la base de datos.</p>";
      html += "</div>";
      
      // Lista de resultados
      html += "<h4>📝 Detalle de Operaciones:</h4>";
      html += "<ul style='list-style: none; padding: 0;'>";
      
      data.results.forEach((res, index) => {
        const isError = res.status.includes("ERROR") || res.status.includes("Error") || res.status.includes("❌");
        const isWarning = res.status.includes("⚠️");
        const isSuccess = res.status.includes("✅");
        
        let itemStyle = "padding: 10px; margin: 5px 0; border-radius: 4px; border-left: 4px solid ";
        let bgColor = "#f5f5f5";
        
        if (isError) {
          itemStyle += "#f44336; background-color: #ffebee;";
        } else if (isWarning) {
          itemStyle += "#ff9800; background-color: #fff3e0;";
        } else if (isSuccess) {
          itemStyle += "#4caf50; background-color: #e8f5e8;";
        } else {
          itemStyle += "#2196f3; background-color: #e3f2fd;";
        }
        
        html += `<li style="${itemStyle}">`;
        html += `<strong>${res.objectName}</strong><br>`;
        html += `<span style="font-size: 0.9em;">${res.status}</span>`;
        
        if (res.error) {
          html += `<br><em style="color: #d32f2f; font-size: 0.8em;">Detalle: ${res.error}</em>`;
        }
        
        if (res.errorCode) {
          html += `<br><em style="color: #666; font-size: 0.8em;">Código de error: ${res.errorCode}</em>`;
        }
        
        html += "</li>";
      });
      html += "</ul>";
      
      // Panel de recomendaciones
      html += "<div style='background-color: #e3f2fd; padding: 15px; border-radius: 8px; margin-top: 20px; border-left: 4px solid #2196f3;'>";
      html += "<h4 style='margin: 0 0 10px 0; color: #1976d2;'>💡 Recomendaciones:</h4>";
      html += "<ul style='margin: 5px 0; padding-left: 20px;'>";
      html += "<li>Revisa y corrige el script que causó el error</li>";
      html += "<li>Verifica la sintaxis SQL y las dependencias</li>";
      html += "<li>Considera el orden de ejecución de los scripts</li>";
      html += "<li>Una vez corregido, puedes volver a ejecutar desde donde se detuvo</li>";
      html += "</ul>";
      html += "</div>";
      
      resultContainer.innerHTML = html;
    } else {
      // No hay resultados parciales
      resultContainer.innerHTML = `
        <div style='background-color: #ffebee; padding: 15px; border-radius: 8px; border-left: 4px solid #f44336;'>
          <h4 style='margin: 0 0 10px 0; color: #d32f2f;'>❌ Error Inicial</h4>
          <p>${data.message}</p>
        </div>
      `;
    }
    return;
  }

  // PROCESO EXITOSO - TODOS LOS SCRIPTS APLICADOS
  console.log('Proceso completado exitosamente:', data);
  
  let html = "<h3>🎉 Proceso Completado Exitosamente</h3>";
  
  // Panel de éxito
  html += "<div style='background-color: #e8f5e8; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #4caf50;'>";
  html += "<h4 style='margin: 0 0 10px 0; color: #2e7d32;'>✅ ÉXITO TOTAL</h4>";
  html += `<p>${data.message}</p>`;
  
  if (data.processedScripts && data.totalScripts) {
    html += `<p><strong>Scripts procesados:</strong> ${data.processedScripts} de ${data.totalScripts}</p>`;
  }
  
  html += "</div>";
  
  // Lista de resultados exitosos
  html += "<h4>📝 Detalle de Operaciones:</h4>";
  html += "<ul style='list-style: none; padding: 0;'>";
  
  data.results.forEach((res) => {
    const isBackup = res.status.includes("Backup");
    const isSuccess = res.status.includes("✅");
    const isWarning = res.status.includes("⚠️");
    
    let itemStyle = "padding: 8px; margin: 3px 0; border-radius: 4px; border-left: 4px solid ";
    
    if (isWarning) {
      itemStyle += "#ff9800; background-color: #fff3e0;";
    } else if (isBackup) {
      itemStyle += "#2196f3; background-color: #e3f2fd;";
    } else {
      itemStyle += "#4caf50; background-color: #e8f5e8;";
    }
    
    html += `<li style="${itemStyle}">`;
    html += `<strong>${res.objectName}</strong>: <span style="font-size: 0.9em;">${res.status}</span>`;
    html += "</li>";
  });
  html += "</ul>";

  resultContainer.innerHTML = html;
});