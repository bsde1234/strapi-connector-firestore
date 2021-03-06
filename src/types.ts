import type { Firestore, CollectionReference } from '@google-cloud/firestore';

export interface Options {
  useEmulator: boolean
  singleId: string,
}

declare global {
  const strapi: Strapi
}

export interface Strapi {
  config: any
  components: Record<string, FirestoreConnectorModel>
  models: Record<string, FirestoreConnectorModel>
  admin: StrapiPlugin
  plugins: Record<string, StrapiPlugin>
  db: any

  getModel(ref, source): FirestoreConnectorModel

  query(modelKey: string): StrapiQuery
}

export interface StrapiPlugin {
  models: Record<string, FirestoreConnectorModel>
}

export interface StrapiQuery {
  find(params: any): Promise<any[]>
  findOne(params: any): Promise<any>
  create(params: any, values: any): Promise<any>
  update(params: any, values: any): Promise<any>
  delete(params: any): Promise<any>
  count(params: any): Promise<number>
  search(params: any): Promise<any[]>
  countSearch(params: any): Promise<number>
}

export interface StrapiQueryParams {
  model: FirestoreConnectorModel
  modelKey: string
  strapi: Strapi
}

export interface StrapiModel {
  connector: string
  connection: string
  primaryKey: string
  primaryKeyType: string
  attributes: Record<string, any>
  collectionName: string
  kind: 'collectionType' | 'singleType'
  globalId: string
  orm: string
  options: {
    timestamps: boolean | [string, string]
  }
  associations: StrapiAssociation[]
}

export type StrapiRelation = 'oneWay' | 'manyWay' | 'oneToMany' | 'oneToOne' | 'manyToMany' | 'manyToOne' | 'oneToManyMorph' | 'manyToManyMorph' | 'manyMorphToMany' | 'manyMorphToOne' | 'oneMorphToOne' | 'oneMorphToMany';

export interface StrapiAssociation {
  alias: string
  autoPopulate: boolean
  collection: string
  dominant: boolean
  filter: string
  nature: StrapiRelation
  plugin: string
  type: string
  via: string
  model: string
}

export interface StrapiFilter {
  sort?: { field: string, order: 'asc' | 'desc'  }[]
  start?: number,
  limit?: number,
  where?: StrapiWhereFilter[]
}

export interface StrapiWhereFilter {
  field: string
  operator: 'eq' | 'ne' | 'in' | 'nin' | 'contains' | 'ncontains' | 'containss' | 'ncontainss' | 'lt' | 'lte' | 'gt' | 'gte' | 'null'
  value: any
}

export interface FirestoreConnectorContext {
  instance: Firestore
  strapi: Strapi
  connection: StrapiModel,
  options: Options
}

export type FirestoreConnectorModel = CollectionReference & StrapiModel & {
  _attributes: Record<string, any>


  assocKeys: string[];
  componentKeys: string[];
  idKeys: string[];
  excludedKeys: string[];
  defaultPopulate: string[];
  
  hasPK: (obj: any) => boolean;
  getPK: (obj: any) => string;
  pickRelations: (obj: any) => any;
  omitExernalValues: (obj: any) => any;
}
