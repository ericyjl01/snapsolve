# Generates the live-test problem screenshots in test/fixtures/problems/ (task 012): four 1280x800 PNGs that look
# like a screen with one problem on it. Windows only (System.Drawing); the PNGs are committed, so this runs only
# when a fixture changes. Usage: powershell -NoProfile -File scripts/make-problem-fixtures.ps1
param([string]$OutDir = (Join-Path $PSScriptRoot "..\test\fixtures\problems"))
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$W = 1280
$H = 800
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Brush([int]$r, [int]$g, [int]$b) { New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($r, $g, $b)) }
function Font([string]$family, [float]$size, [string]$style = "Regular") {
  New-Object System.Drawing.Font $family, $size, ([System.Drawing.FontStyle]::$style), ([System.Drawing.GraphicsUnit]::Pixel)
}

# A window: dark title bar with the app title, a light client area, then $draw paints the content.
function Save-Screen([string]$name, [string]$title, [int[]]$client, [scriptblock]$draw) {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::FromArgb(32, 32, 32))
  $g.DrawString($title, (Font "Segoe UI" 15), [System.Drawing.Brushes]::Gainsboro, 16, 10)
  $g.FillRectangle((Brush $client[0] $client[1] $client[2]), 0, 40, $W, $H - 80)
  $g.FillRectangle((Brush 24 24 24), 0, $H - 40, $W, 40)
  $g.DrawString("10:42", (Font "Segoe UI" 14), [System.Drawing.Brushes]::Gainsboro, $W - 70, $H - 30)
  & $draw $g
  $g.Dispose()
  $bmp.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$ink = Brush 20 20 20
$muted = Brush 100 100 100

Save-Screen "algebra" "Algebra 1 - Homework 4.2" @(255, 255, 255) {
  param($g)
  $g.DrawString("Homework 4.2 - Linear equations", (Font "Segoe UI" 30 "Bold"), $ink, 80, 90)
  $g.DrawString("Problem 7", (Font "Segoe UI" 24 "Bold"), $ink, 80, 190)
  $g.DrawString("Solve for x.", (Font "Segoe UI" 24), $ink, 80, 240)
  $g.DrawString("3(x " + [char]0x2212 + " 4) + 2x = 2x + 9", (Font "Cambria Math" 44), $ink, 140, 310)
  $g.DrawString("Show your work.", (Font "Segoe UI" 20 "Italic"), $muted, 80, 420)
}

Save-Screen "rates" "Word problems - Review sheet" @(255, 255, 255) {
  param($g)
  $g.DrawString("Review sheet - Rates of work", (Font "Segoe UI" 30 "Bold"), $ink, 80, 90)
  $g.DrawString("Problem 3", (Font "Segoe UI" 24 "Bold"), $ink, 80, 190)
  $text = "Pipe A can fill a tank in 6 hours and pipe B can fill it in 9 hours. A drain can empty the full " +
    "tank in 12 hours. The tank starts empty, and both pipes and the drain are opened at the same time. " +
    "How long does it take to fill the tank?"
  $g.DrawString($text, (Font "Segoe UI" 28), $ink, (New-Object System.Drawing.RectangleF 80, 250, 1100, 300))
}

Save-Screen "code-bug" "average.py - Visual Studio Code" @(30, 30, 30) {
  param($g)
  $code = @(
    "def average(nums):",
    "    total = 0",
    "    for i in range(1, len(nums)):",
    "        total += nums[i]",
    "    return total / len(nums)",
    "",
    "print(average([4, 8, 6]))  # should print 6.0"
  )
  $mono = Font "Consolas" 26
  for ($i = 0; $i -lt $code.Count; $i++) {
    $y = 80 + $i * 40
    $g.DrawString(("{0,2}" -f ($i + 1)), $mono, (Brush 110 118 129), 30, $y)
    $g.DrawString($code[$i], $mono, (Brush 212 212 212), 100, $y)
  }
  $g.FillRectangle((Brush 24 24 24), 0, 470, $W, 290)
  $g.DrawString("TERMINAL", (Font "Segoe UI" 16 "Bold"), (Brush 200 200 200), 30, 485)
  $g.DrawString("PS C:\work> python average.py", $mono, (Brush 204 204 204), 30, 530)
  $g.DrawString("4.666666666666667", $mono, (Brush 204 204 204), 30, 570)
  $g.DrawString("PS C:\work> ", $mono, (Brush 204 204 204), 30, 610)
}

Save-Screen "multiple-choice" "Quiz 2 - Number sense" @(250, 250, 252) {
  param($g)
  $g.DrawString("Question 5 of 10", (Font "Segoe UI" 22) , $muted, 80, 90)
  $g.DrawString("Which of the following numbers is prime?", (Font "Segoe UI" 32 "Bold"), $ink, 80, 140)
  $options = @("A)  21", "B)  27", "C)  29", "D)  33")
  for ($i = 0; $i -lt $options.Count; $i++) {
    $y = 240 + $i * 80
    $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 120, 120)), 2), 90, $y + 8, 28, 28)
    $g.DrawString($options[$i], (Font "Segoe UI" 30), $ink, 140, $y)
  }
  $g.FillRectangle((Brush 0 103 192), 1000, 620, 180, 56)
  $g.DrawString("Submit", (Font "Segoe UI" 26 "Bold"), [System.Drawing.Brushes]::White, 1045, 630)
}

Get-ChildItem $OutDir -Filter *.png | ForEach-Object { "{0} {1} bytes" -f $_.Name, $_.Length }
