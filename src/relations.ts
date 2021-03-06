import * as _ from 'lodash';
import { FieldValue, DocumentReference } from '@google-cloud/firestore';
import { getDocRef, getModel } from './utils/get-doc-ref';
import { FirestoreConnectorModel } from './types';
import { TransactionWrapper } from './utils/transaction-wrapper';

interface MorphDef {
  id?: DocumentReference
  alias: string
  refId: DocumentReference
  ref: string
  field: string
  filter: string
}

const removeUndefinedKeys = (obj: any) => _.pickBy(obj, _.negate(_.isUndefined));

const addRelationMorph = (params: MorphDef, transaction: TransactionWrapper | undefined) => {
  const { id, alias, refId, ref, field, filter } = params;

  setMerge(
    id!, 
    {
      [alias]: FieldValue.arrayUnion({
        ref: refId,
        kind: ref,
        [filter]: field,
      })
    },
    transaction
  );
};

const removeRelationMorph = async (model: FirestoreConnectorModel, params: MorphDef, transaction: TransactionWrapper | undefined) => {
  const { id, alias, filter, field, ref, refId } = params;

  const value = {
    [alias]: FieldValue.arrayRemove({
      ref: refId,
      kind: ref,
      [filter]: field,
    }),
  };

  if (id) {
    setMerge(id, value, transaction);

  } else {

    const q = model.where(alias, 'array-contains', value);
    const docs = (await (transaction ? transaction.get(q) : q.get())).docs;
    docs.forEach(d => {
      setMerge(d.ref, value, transaction);
    });
  }
};


const setMerge = (ref: DocumentReference, data: any, transaction: TransactionWrapper | undefined) => {
  transaction
    ? transaction.addWrite((trans)  => trans.set(ref, data, { merge: true }))
    : ref.set(data, { merge: true });
}


export async function updateRelations(model: FirestoreConnectorModel, params: { entry, data, values, ref: DocumentReference }, transaction?: TransactionWrapper) {

  const { entry, data, ref } = params;
  const relationUpdates: Promise<any>[] = [];

  // Only update fields which are on this document.
  Object.keys(removeUndefinedKeys(params.values)).forEach((attribute) => {
    const details = model._attributes[attribute];
    const association = model.associations.find(x => x.alias === attribute)!;

    const assocModel = getModel(details.model || details.collection, details.plugin);
    if (!assocModel) {
      throw new Error('Associated model no longer exists');
    }

    const currentRef = getDocRef(entry[attribute], assocModel);
    const newRef = getDocRef(params.values[attribute], assocModel);

    switch (association.nature) {
      case 'oneWay': {
        if (_.isArray(newRef)) {
          throw new Error('oneWay relation cannot be an array');
        }
        return _.set(data, attribute, newRef);
      }

      case 'oneToOne': {
        if (_.isArray(currentRef) || _.isArray(newRef)) {
          throw new Error('oneToOne relation cannot be an array');
        }

        // if value is the same don't do anything
        if (newRef?.id === currentRef?.id) return;

        // if the value is null, set field to null on both sides
        if (!newRef) {
          if (currentRef) {
            setMerge(currentRef, { [details.via]: null }, transaction);
          }
          return _.set(data, attribute, null);
        }

        // set old relations to null
        relationUpdates.push((transaction ? transaction.get(newRef) : newRef.get()).then(snap => {
          const d = snap.data();
          if (d && d[details.via]) {
            const oldLink = getDocRef(d[details.via], assocModel);
            if (oldLink) {
              setMerge(oldLink as DocumentReference, { [attribute]: null }, transaction);
            }
          }

          // set new relation
          setMerge(newRef, { [details.via]: ref }, transaction);

        }));
        return _.set(data, attribute, newRef);
      }

      case 'oneToMany': {
        // set relation to null for all the ids not in the list
        const currentArray = currentRef ? _.castArray(currentRef): [];
        const newArray = newRef ? _.castArray(newRef) : [];
        const toRemove = _.differenceWith(currentArray, newArray, (a, b) => a.id === b.id);
        
        toRemove.forEach(r => {
          setMerge(r, { [details.via]: null }, transaction);
        });
        newArray.map(r => {
          setMerge(r, { [details.via]: ref }, transaction);
        });
        
        return;
      }
      
      case 'manyToOne': {
        return _.set(data, attribute, newRef);
      }

      case 'manyWay':
      case 'manyToMany': {
        if (association.dominant) {
          return _.set(data, attribute, newRef);
        }
        if (!_.isArray(currentRef) || !_.isArray(newRef)) {
          throw new Error('manyToMany relation must be an array');
        }

        currentRef.map(v => {
          setMerge(v, { [association.via]: FieldValue.arrayRemove(ref) }, transaction);
        });
        newRef.map(v => {
          setMerge(v, { [association.via]: FieldValue.arrayUnion(ref) }, transaction);
        });

        return;
      }

      // media -> model
      case 'manyMorphToMany':
      case 'manyMorphToOne': {

        const newValue = params.values[attribute];
        if (!_.isArray(newValue)) {
          throw new Error('manyMorphToMany or manyMorphToOne relation must be an array');
        }

        relationUpdates.push(Promise.all(newValue.map(async obj => {
          const refModel = strapi.getModel(obj.ref, obj.source);

          const createRelation = () => {
            return addRelationMorph({
              id: ref,
              alias: association.alias,
              ref: obj.kind || refModel.globalId,
              refId: model.doc(obj.refId),
              field: obj.field,
              filter: association.filter,
            }, transaction);
          };

          // Clear relations to refModel
          const reverseAssoc = refModel.associations.find(assoc => assoc.alias === obj.field);
          if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
            await removeRelationMorph(model, {
              alias: association.alias,
              ref: obj.kind || refModel.globalId,
              refId: model.doc(obj.refId),
              field: obj.field,
              filter: association.filter,
            }, transaction);
            createRelation();
            setMerge(refModel.doc(obj.refId), {
              [obj.field]: ref
            }, transaction);
          } else {
            createRelation();
            setMerge(refModel.doc(obj.refId), FieldValue.arrayUnion(ref), transaction);
          }
        })));
        break;
      }

      // model -> media
      case 'oneToManyMorph':
      case 'manyToManyMorph': {
        const newIds = newRef ? _.castArray(newRef) : [];
        const currentIds = currentRef ? _.castArray(currentRef) : [];

        // Compare array of ID to find deleted files.
        const toAdd = _.differenceWith(newIds, currentIds, (a, b) => a.id === b.id);
        const toRemove = _.differenceWith(currentIds, currentIds, (a, b) => a.id === b.id);

        const morphModel = getModel(details.model || details.collection, details.plugin);

        _.set(data, attribute, newIds);

        toRemove.map(id => {
          relationUpdates.push(removeRelationMorph(morphModel!, {
            id,
            alias: association.via,
            ref: model.globalId,
            refId: ref,
            field: association.alias,
            filter: association.filter,
          }, transaction));
        });

        toAdd.forEach(id => {
          addRelationMorph({
            id,
            alias: association.via,
            ref: model.globalId,
            refId: ref,
            field: association.alias,
            filter: association.filter,
          }, transaction);
        });

        break;
      }
      case 'oneMorphToOne':
      case 'oneMorphToMany':
        break;
      default:
    }
  });

  await Promise.all(relationUpdates);
}

export async function deleteRelations(model: FirestoreConnectorModel, params: { entry: any, ref: DocumentReference}, transaction: TransactionWrapper | undefined) {
  const { entry, ref } = params;

  await Promise.all(
    model.associations.map(async association => {
      const { nature, via, dominant, alias } = association;
      const details = model._attributes[alias];
  
      const assocModel = getModel(details.model || details.collection, details.plugin);
      if (!assocModel) {
        throw new Error('Associated model no longer exists');
      }
      const currentValue = getDocRef(entry[alias], assocModel);

      // TODO: delete all the ref to the model

      switch (nature) {
        case 'oneWay':
        case 'manyWay': {
          return;
        }

        case 'oneToMany':
        case 'oneToOne': {
          if (!via || !currentValue) {
            return;
          }
          if (_.isArray(currentValue)) {
            throw new Error('oneToMany or oneToOne relation must not be an array');
          }
          setMerge(currentValue, { [via]: null }, transaction);
          return;
        }

        case 'manyToMany':
        case 'manyToOne': {
          if (!via || dominant || !currentValue) {
            return;
          }
          if (_.isArray(currentValue)) {
            currentValue.forEach(v => {
              setMerge(v, { [via]: FieldValue.arrayRemove(ref) }, transaction);
            });
          } else {
            setMerge(currentValue, { [via]: FieldValue.arrayRemove(ref) }, transaction);
          }
          return;
        }

        case 'oneToManyMorph':
        case 'manyToManyMorph': {
          // delete relation inside of the ref model
          const targetModel: FirestoreConnectorModel = strapi.db.getModel(
            association.model || association.collection,
            association.plugin
          );

          // ignore them ghost relations
          if (!targetModel) return;

          const element = {
            ref,
            kind: model.globalId,
            [association.filter]: association.alias,
          };

          setMerge(ref, { [via]: FieldValue.arrayRemove(element) }, transaction);
          return;
        }

        case 'manyMorphToMany':
        case 'manyMorphToOne': {
          // delete relation inside of the ref model

          if (Array.isArray(entry[association.alias])) {
            return Promise.all(
              entry[association.alias].map(async val => {
                const targetModel = strapi.db.getModelByGlobalId(val.kind);

                // ignore them ghost relations
                if (!targetModel) return;

                const field = val[association.filter];
                const reverseAssoc = targetModel.associations.find(
                  assoc => assoc.alias === field
                );

                const q = targetModel.where(targetModel.primaryKey, '==', val.ref && (val.ref._id || val.ref));
                const docs = (await (transaction ? transaction.get(q) : q.get())).docs;

                if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
                  docs.forEach(d => {
                    setMerge(d, { [field]: null }, transaction);
                  });
                } else {
                  docs.forEach(d => {
                    setMerge(d, { [field]: FieldValue.arrayRemove(ref) }, transaction);
                  });
                }
              })
            );
          }

          return;
        }

        case 'oneMorphToOne':
        case 'oneMorphToMany': {
          return;
        }

        default:
          return;
      }
    })
  );
}
  