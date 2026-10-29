$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'MiniMax para Codex - Clave NVIDIA'
$form.ClientSize = New-Object System.Drawing.Size(510, 175)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Introduce tu clave de NVIDIA (nvapi-...). Se guarda cifrada para este usuario.'
$label.SetBounds(15, 15, 480, 35)
$inputBox = New-Object System.Windows.Forms.TextBox
$inputBox.UseSystemPasswordChar = $true
$inputBox.SetBounds(15, 55, 480, 28)
$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = 'Guardar y continuar'
$saveButton.SetBounds(180, 110, 170, 32)
$saveButton.Add_Click({
  if ($inputBox.Text.Trim() -notmatch '^nvapi-[A-Za-z0-9_-]{10,}$') {
    [System.Windows.Forms.MessageBox]::Show('La clave debe comenzar por nvapi-.', 'Revisa la clave') | Out-Null
    return
  }
  $secret = ConvertTo-SecureString -String $inputBox.Text.Trim() -AsPlainText -Force
  $cipher = ConvertFrom-SecureString -SecureString $secret
  [System.IO.Directory]::CreateDirectory($env:JDC_MINIMAX_DATA) | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $env:JDC_MINIMAX_DATA 'nvidia-key.dpapi'), $cipher)
  $inputBox.Clear()
  $secret.Dispose()
  $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Close()
})
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = 'Cancelar'
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancelButton.SetBounds(365, 110, 130, 32)
$form.Controls.AddRange(@($label, $inputBox, $saveButton, $cancelButton))
$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton
$answer = $form.ShowDialog()
$form.Dispose()
if ($answer -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
