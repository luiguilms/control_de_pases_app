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

// Escuchar respuesta del backend y mostrar resultados
ipcRenderer.on("apply-scripts-response", (event, data) => {
  applyLoader.style.display = "none";
  startApplyButton.disabled = false;

  if (!data.success) {
    alert("Error: " + data.message);
    return;
  }

  let html = "<h3>Resultados de Aplicación de Scripts:</h3><ul>";
  data.results.forEach((res) => {
    html += `<li><strong>${res.objectName}</strong>: ${res.status}`;
    if (res.error) html += `<br><em>Error:</em> ${res.error}`;
    html += "</li>";
  });
  html += "</ul>";

  resultContainer.innerHTML = html;
});