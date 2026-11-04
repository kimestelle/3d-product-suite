/** Return to valid remembered work; the supplied watch is the first-use sample. */
export function startupProjectId(projects:readonly {id:string;name:string}[],fallback:string,remembered:string|null):string {
  return projects.find(project=>project.id===remembered)?.id
    ?? projects.find(project=>project.name==='Auden watch')?.id
    ?? fallback;
}
