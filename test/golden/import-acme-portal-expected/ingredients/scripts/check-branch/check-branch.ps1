# Refuse to run on a default branch.
$branch = git symbolic-ref --short HEAD
if ($branch -in @('main', 'master')) { throw "on $branch - create a feat/<slug> branch first" }
Write-Output "branch $branch ok"
