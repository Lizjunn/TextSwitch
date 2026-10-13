$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskIconDir = Join-Path $PSScriptRoot '../extension/icons'
[System.IO.Directory]::CreateDirectory($taskIconDir) | Out-Null
foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(24, 117, 93))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $radius = [single]($size * 0.22)
  $edge = [single]($size - 1)
  $path.AddArc(0, 0, $radius, $radius, 180, 90)
  $path.AddArc($edge - $radius, 0, $radius, $radius, 270, 90)
  $path.AddArc($edge - $radius, $edge - $radius, $radius, $radius, 0, 90)
  $path.AddArc(0, $edge - $radius, $radius, $radius, 90, 90)
  $path.CloseFigure()
  $graphics.FillPath($background, $path)
  $font = New-Object System.Drawing.Font('Microsoft YaHei', [single]($size * 0.56), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, [single](-$size * 0.01), $size, $size)
  $graphics.DrawString('文', $font, [System.Drawing.Brushes]::White, $rect, $format)
  $bitmap.Save((Join-Path $taskIconDir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $font.Dispose()
  $format.Dispose()
  $path.Dispose()
  $background.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
