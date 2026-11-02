/** The supplied watch is the cover's studio entry; other workspaces keep their
 * existing remembered-project behavior when that optional campaign is absent. */
export function startupProjectId(projects:readonly {id:string;name:string}[],fallback:string,remembered:string|null):string {
  return projects.find(project=>project.name==='Auden watch')?.id
    ?? projects.find(project=>project.id===remembered)?.id
    ?? fallback;
}
