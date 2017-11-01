/**
 * Copyright ©2017. The Regents of the University of California (Regents). All Rights Reserved.
 *
 * Permission to use, copy, modify, and distribute this software and its documentation
 * for educational, research, and not-for-profit purposes, without fee and without a
 * signed licensing agreement, is hereby granted, provided that the above copyright
 * notice, this paragraph and the following two paragraphs appear in all copies,
 * modifications, and distributions.
 *
 * Contact The Office of Technology Licensing, UC Berkeley, 2150 Shattuck Avenue,
 * Suite 510, Berkeley, CA 94720-1620, (510) 643-7201, otl@berkeley.edu,
 * http://ipira.berkeley.edu/industry-info for commercial licensing opportunities.
 *
 * IN NO EVENT SHALL REGENTS BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL,
 * INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF
 * THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF REGENTS HAS BEEN ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * REGENTS SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE
 * SOFTWARE AND ACCOMPANYING DOCUMENTATION, IF ANY, PROVIDED HEREUNDER IS PROVIDED
 * "AS IS". REGENTS HAS NO OBLIGATION TO PROVIDE MAINTENANCE, SUPPORT, UPDATES,
 * ENHANCEMENTS, OR MODIFICATIONS.
 */

var _ = require('lodash');
var config = require('config');
var path = require('path');
var fs = require('fs');

var constants = require('./constants');
var log = require('../logger')('sqlGenerator');
var storage = require('./storage');

/**
 * Upload the compressed data files for each table from Canvas Data on to S3 buckets.
 *
 * @param  {Function}         callback                Standard callback function
 * @param  {Object}           callback.err            An error object, if any
 */
var createRedshiftTemplates = module.exports.createRedshiftTemplates = function(callback) {
  var dbCreationTemplateInput = path.join(__dirname, '/db-templates/dbCreation.template');
  var dbCreationTemplateOutput = path.join(__dirname, '/db-templates/dbCreation.sql');
  var dbRepointTemplateInput = path.join(__dirname, '/db-templates/dbRepoint.template');
  var dbRepointTemplateOutput = path.join(__dirname, '/db-templates/dbRepoint.sql');

  generateCanvasDataSql(dbCreationTemplateInput, dbCreationTemplateOutput, function(err) {
    if (err) {
      return callback(err);
    }

    generateCanvasDataSql(dbRepointTemplateInput, dbRepointTemplateOutput, function(err) {
      if (err) {
        return callback(err);
      }

      return callback();
    });
  });
};

/**
 * @param  {Number}       year                Requested year of enrollments
 * @param  {String}       semesterCode        Requested semester of enrollments: 'B' for Spring, 'C' for Summer and 'D' for Fall.
 * @param  {Number[]}     uids                One or more user UIDs
 * @return {String}                           Valid SQL intended for the 'lakeview' database
 */
var constructEnrollmentsSQL = module.exports.constructEnrollmentsSQL = function(year, semesterCode, uids, callback) {
  var termId = constants.BCOURSES.ENROLLMENT_TERM[year + semesterCode];

  if (!termId) {
    return callback({message: 'Error. No bCourses termId available for ' + year + semesterCode});
  }

  var tokenMap = {
    year: year,
    semesterCode: semesterCode,
    enrollmentTermId: termId,
    uids: '\'' + _.concat(uids.join('\', \'')) + '\''
  };
  var sql = `
    SELECT
      DISTINCT(p.unique_name, c.canvas_id),
      p.unique_name AS uid,
      u.name person_name,
      c.canvas_id AS canvas_course_id,
      c.name AS course_name,
      c.code as course_code,
      :year as year,
      ':semesterCode' as semesterCode
    FROM user_dim u
      JOIN enrollment_fact e ON e.user_id = u.id
      JOIN course_dim c ON c.id = e.course_id
      JOIN pseudonym_dim p ON p.user_id = u.id
    WHERE
      e.enrollment_term_id = :enrollmentTermId
      AND
      p.unique_name IN (:uids)
    ORDER BY
      p.unique_name,
      c.canvas_id
  `;

  _.each(tokenMap, function(value, key) {
    sql = sql.replace(':' + key, value);
  });

  return callback(null, sql);
};

/**
 * Upload the compressed data files for each table from Canvas Data on to S3 buckets.
 *
 * @param  {String}           templateFile            Path to the template file to generate sql scripts
 * @param  {String}           outputFile              Path to where the template output file will be uploaded
 * @param  {Function}         callback                Standard callback function
 * @param  {Object}           callback.err            An error object, if any
 */
var generateCanvasDataSql = function(templateFile, outputFile, callback) {
  // Read the Canvas data DB creation template
  fs.readFile(templateFile, 'utf8', function(err, template) {
    if (err) {
      return log.error('An error occurred when reading the Apache config template');
    }
    // generate a daily hash which will be the location the data dumps for the day reside.
    var dailyHash = storage.generateHash();
    // Generate the template ouput replacing the following parameters in the sql file
    var templateData = {
      externalDatabase: config.get('dataLake.canvasData.externalDatabase'),
      s3Location: config.get('dataLake.canvasData.s3Location') + '/' + dailyHash,
      iamRole: config.get('dataLake.canvasData.iamRole')
    };
    var templateOutput = _.template(template)(templateData);

    // Store the generated template output sql file
    fs.writeFile(outputFile, templateOutput, function(err) {
      if (err) {
        log.error('An error occurred when writing the generated canvas data initialization sql file');
        return callback(err);
      }

      log.info('Successfully generated the canvas data initialization sql file');
      return callback();
    });
  });
};